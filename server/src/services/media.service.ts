import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { extname } from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { SystemConfig } from 'src/config';
import { FACE_THUMBNAIL_SIZE, JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { ImagePathOptions, StorageCore, ThumbnailPathEntity } from 'src/cores/storage.core';
import { AssetFile } from 'src/database';
import { OnEvent, OnJob } from 'src/decorators';
import { AssetEditAction, CropParameters } from 'src/dtos/editing.dto';
import { SystemConfigFFmpegDto } from 'src/dtos/system-config.dto';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  AudioCodec,
  Colorspace,
  ImageFormat,
  JobName,
  JobStatus,
  LogLevel,
  QueueName,
  RawExtractedFormat,
  StorageFolder,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  TranscodeTarget,
  VideoCodec,
  VideoContainer,
} from 'src/enum';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { S3AppStorageBackend } from 'src/storage/s3-backend';
import { BoundingBox } from 'src/repositories/machine-learning.repository';
import { BaseService } from 'src/services/base.service';
import {
  AudioStreamInfo,
  DecodeToBufferOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  JobItem,
  JobOf,
  VideoFormat,
  VideoInterfaces,
  VideoStreamInfo,
} from 'src/types';
import { getAssetFile, getDimensions } from 'src/utils/asset.util';
import { checkFaceVisibility, checkOcrVisibility } from 'src/utils/editor';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media';
import { mimeTypes } from 'src/utils/mime-types';
import { clamp, isFaceImportEnabled, isFacialRecognitionEnabled } from 'src/utils/misc';
import { getOutputDimensions } from 'src/utils/transform';

interface UpsertFileOptions {
  assetId: string;
  type: AssetFileType;
  path: string;
  isEdited: boolean;
  isProgressive: boolean;
  isTransparent: boolean;
}

type ThumbnailAsset = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

@Injectable()
export class MediaService extends BaseService {
  videoInterfaces: VideoInterfaces = { dri: [], mali: false };
  private _s3: S3AppStorageBackend | null | undefined;

  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    const [dri, mali] = await Promise.all([this.getDevices(), this.hasMaliOpenCL()]);
    this.videoInterfaces = { dri, mali };
  }

  @OnJob({ name: JobName.AssetGenerateThumbnailsQueueAll, queue: QueueName.ThumbnailGeneration })
  async handleQueueGenerateThumbnails({ force }: JobOf<JobName.AssetGenerateThumbnailsQueueAll>): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: true });
    let jobs: JobItem[] = [];

    const queueAll = async () => {
      await this.jobRepository.queueAll(jobs);
      jobs = [];
    };

    const fullsizeEnabled = config.image.fullsize.enabled;
    for await (const asset of this.assetJobRepository.streamForThumbnailJob({ force, fullsizeEnabled })) {
      if (force || !asset.isEdited) {
        jobs.push({ name: JobName.AssetGenerateThumbnails, data: { id: asset.id } });
      }

      if (asset.isEdited) {
        jobs.push({ name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } });
      }

      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await queueAll();
      }
    }

    await queueAll();

    const people = this.personRepository.getAll(force ? undefined : { thumbnailPath: '' });

    for await (const person of people) {
      if (!person.faceAssetId) {
        const face = await this.personRepository.getRandomFace(person.id);
        if (!face) {
          continue;
        }

        await this.personRepository.update({ id: person.id, faceAssetId: face.id });
      }

      jobs.push({ name: JobName.PersonGenerateThumbnail, data: { id: person.id } });
      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await queueAll();
      }
    }

    await queueAll();

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FileMigrationQueueAll, queue: QueueName.Migration })
  async handleQueueMigration(): Promise<JobStatus> {
    const { active, waiting } = await this.jobRepository.getJobCounts(QueueName.Migration);
    if (active === 1 && waiting === 0) {
      await this.storageCore.removeEmptyDirs(StorageFolder.Thumbnails);
      await this.storageCore.removeEmptyDirs(StorageFolder.EncodedVideo);
    }

    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForMigrationJob();
    for await (const asset of assets) {
      jobs.push({ name: JobName.AssetFileMigration, data: { id: asset.id } });
      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);
    jobs = [];

    for await (const person of this.personRepository.getAll()) {
      jobs.push({ name: JobName.PersonFileMigration, data: { id: person.id } });

      if (jobs.length === JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetFileMigration, queue: QueueName.Migration })
  async handleAssetMigration({ id }: JobOf<JobName.AssetFileMigration>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const asset = await this.assetJobRepository.getForMigrationJob(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    await this.storageCore.moveAssetImage(asset, AssetFileType.FullSize, image.fullsize.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Preview, image.preview.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Thumbnail, image.thumbnail.format);
    await this.storageCore.moveAssetVideo(asset);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEditThumbnailGeneration, queue: QueueName.Editor })
  async handleAssetEditThumbnailGeneration({ id }: JobOf<JobName.AssetEditThumbnailGeneration>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    const generated = await this.generateEditedThumbnails(asset, config);
    await this.syncFiles(
      asset.files.filter((file) => file.isEdited),
      generated?.files ?? [],
    );

    let thumbhash: Buffer | undefined = generated?.thumbhash;
    if (!thumbhash) {
      const extractedImage = await this.extractOriginalImage(asset, config.image);
      const { info, data, colorspace } = extractedImage;

      thumbhash = await this.mediaRepository.generateThumbhash(data, {
        colorspace,
        processInvalidImages: false,
        raw: info,
        edits: [],
      });
    }

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    const fullsizeDimensions = generated?.fullsizeDimensions ?? getDimensions(asset.exifInfo!);
    await this.assetRepository.update({ id: asset.id, ...fullsizeDimensions });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetGenerateThumbnails, queue: QueueName.ThumbnailGeneration })
  async handleGenerateThumbnails({ id }: JobOf<JobName.AssetGenerateThumbnails>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.verbose(`Thumbnail generation skipped for asset ${id}: not visible`);
      return JobStatus.Skipped;
    }

    let generated: Awaited<ReturnType<MediaService['generateImageThumbnails']>>;
    if (asset.type === AssetType.Video || asset.originalFileName.toLowerCase().endsWith('.gif')) {
      this.logger.verbose(`Thumbnail generation for video ${id} ${asset.originalPath}`);
      generated = await this.generateVideoThumbnails(asset, config);
    } else if (asset.type === AssetType.Image) {
      this.logger.verbose(`Thumbnail generation for image ${id} ${asset.originalPath}`);
      generated = await this.generateImageThumbnails(asset, config);
    } else {
      this.logger.warn(`Skipping thumbnail generation for asset ${id}: ${asset.type} is not an image or video`);
      return JobStatus.Skipped;
    }

    const editedGenerated = await this.generateEditedThumbnails(asset, config);
    if (editedGenerated) {
      generated.files.push(...editedGenerated.files);
    }

    await this.syncFiles(asset.files, generated.files);
    const thumbhash = editedGenerated?.thumbhash || generated.thumbhash;

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    return JobStatus.Success;
  }

  private async extractImage(originalPath: string, minSize: number) {
    let extracted = await this.mediaRepository.extract(originalPath);
    if (extracted && !(await this.shouldUseExtractedImage(extracted.buffer, minSize))) {
      extracted = null;
    }

    return extracted;
  }

  private async decodeImage(thumbSource: string | Buffer, exifInfo: ThumbnailAsset['exifInfo'], targetSize?: number) {
    const { image } = await this.getConfig({ withCache: true });
    const colorspace = this.isSRGB(exifInfo) ? Colorspace.Srgb : image.colorspace;
    const decodeOptions: DecodeToBufferOptions = {
      colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      size: targetSize,
      orientation: exifInfo.orientation ? Number(exifInfo.orientation) : undefined,
    };

    const { info, data } = await this.mediaRepository.decodeImage(thumbSource, decodeOptions);
    return { info, data, colorspace };
  }

  private async extractOriginalImage(
    asset: ThumbnailAsset,
    image: SystemConfig['image'],
    useEdits = false,
    sourcePath: string = asset.originalPath,
  ) {
    const extractEmbedded = image.extractEmbedded && mimeTypes.isRaw(asset.originalFileName);
    const extracted = extractEmbedded ? await this.extractImage(sourcePath, image.preview.size) : null;
    const generateFullsize =
      ((image.fullsize.enabled || asset.exifInfo.projectionType === 'EQUIRECTANGULAR') &&
        !mimeTypes.isWebSupportedImage(asset.originalPath)) ||
      useEdits;
    const convertFullsize = generateFullsize && (!extracted || !mimeTypes.isWebSupportedImage(` .${extracted.format}`));

    const { data, info, colorspace } = await this.decodeImage(
      extracted ? extracted.buffer : sourcePath,
      // only specify orientation to extracted images which don't have EXIF orientation data
      // or it can double rotate the image
      extracted ? asset.exifInfo : { ...asset.exifInfo, orientation: null },
      convertFullsize ? undefined : image.preview.size,
    );

    let isTransparent = false;
    if (!extracted && mimeTypes.canBeTransparent(asset.originalPath)) {
      ({ isTransparent } = await this.mediaRepository.getImageMetadata(sourcePath));
    }

    return {
      extracted,
      data,
      info,
      colorspace,
      convertFullsize,
      generateFullsize,
      isTransparent,
    };
  }

  private async generateImageThumbnails(asset: ThumbnailAsset, { image }: SystemConfig, useEdits: boolean = false) {
    const stagedInput = await this.stageInputIfS3(asset.originalPath);
    let previewOutput: Awaited<ReturnType<typeof this.stageOutputIfS3>> | undefined;
    let thumbnailOutput: Awaited<ReturnType<typeof this.stageOutputIfS3>> | undefined;
    let fullsizeFile: UpsertFileOptions | undefined;
    let fullsizeOutput: Awaited<ReturnType<typeof this.stageOutputIfS3>> | undefined;
    let previewFile: UpsertFileOptions | undefined;
    let thumbnailFile: UpsertFileOptions | undefined;

    try {
      // Handle embedded preview extraction for RAW files
      const extractedImage = await this.extractOriginalImage(asset, image, useEdits, stagedInput.localPath);
      const { info, data, colorspace, generateFullsize, convertFullsize, extracted, isTransparent } = extractedImage;

      const previewFormat = image.preview.format;
      this.warnOnTransparencyLoss(isTransparent, previewFormat, asset.id);
      const thumbnailFormat = image.thumbnail.format;
      this.warnOnTransparencyLoss(isTransparent, thumbnailFormat, asset.id);

      previewFile = this.getImageFile(asset, {
        fileType: AssetFileType.Preview,
        format: previewFormat,
        isEdited: useEdits,
        isProgressive: !!image.preview.progressive && previewFormat !== ImageFormat.Webp,
        isTransparent,
      });
      thumbnailFile = this.getImageFile(asset, {
        fileType: AssetFileType.Thumbnail,
        format: thumbnailFormat,
        isEdited: useEdits,
        isProgressive: !!image.thumbnail.progressive && thumbnailFormat !== ImageFormat.Webp,
        isTransparent,
      });
      previewOutput = await this.stageOutputIfS3(previewFile.path);
      thumbnailOutput = await this.stageOutputIfS3(thumbnailFile.path);

      this.storageCore.ensureFolders(previewOutput.localPath);
      this.storageCore.ensureFolders(thumbnailOutput.localPath);

      // generate final images
      const thumbnailOptions = { colorspace, processInvalidImages: false, raw: info, edits: useEdits ? asset.edits : [] };
      const promises = [
        this.mediaRepository.generateThumbhash(data, thumbnailOptions),
        this.mediaRepository.generateThumbnail(data, { ...image.thumbnail, ...thumbnailOptions }, thumbnailOutput.localPath),
        this.mediaRepository.generateThumbnail(data, { ...image.preview, ...thumbnailOptions }, previewOutput.localPath),
      ];

      if (convertFullsize) {
        // convert a new fullsize image from the same source as the thumbnail
        fullsizeFile = this.getImageFile(asset, {
          fileType: AssetFileType.FullSize,
          format: image.fullsize.format,
          isEdited: useEdits,
          isProgressive: !!image.fullsize.progressive && image.fullsize.format !== ImageFormat.Webp,
          isTransparent,
        });
        fullsizeOutput = await this.stageOutputIfS3(fullsizeFile.path);
        this.storageCore.ensureFolders(fullsizeOutput.localPath);
        const fullsizeOptions = {
          format: image.fullsize.format,
          quality: image.fullsize.quality,
          progressive: image.fullsize.progressive,
          ...thumbnailOptions,
        };
        promises.push(this.mediaRepository.generateThumbnail(data, fullsizeOptions, fullsizeOutput.localPath));
      } else if (generateFullsize && extracted && extracted.format === RawExtractedFormat.Jpeg) {
        fullsizeFile = this.getImageFile(asset, {
          fileType: AssetFileType.FullSize,
          format: extracted.format,
          isEdited: false,
          isProgressive: !!image.fullsize.progressive && image.fullsize.format !== ImageFormat.Webp,
          isTransparent,
        });
        fullsizeOutput = await this.stageOutputIfS3(fullsizeFile.path);
        this.storageCore.ensureFolders(fullsizeOutput.localPath);

        // Write the buffer to disk with essential EXIF data
        await this.storageRepository.createOrOverwriteFile(fullsizeOutput.localPath, extracted.buffer);
        await this.mediaRepository.writeExif(
          {
            orientation: asset.exifInfo.orientation,
            colorspace: asset.exifInfo.colorspace,
          },
          fullsizeOutput.localPath,
        );
      }

      const outputs = await Promise.all(promises);

      if (asset.exifInfo.projectionType === 'EQUIRECTANGULAR') {
        await Promise.all([
          this.mediaRepository.copyTagGroup('XMP-GPano', stagedInput.localPath, previewOutput.localPath),
          fullsizeOutput
            ? this.mediaRepository.copyTagGroup('XMP-GPano', stagedInput.localPath, fullsizeOutput.localPath)
            : Promise.resolve(),
        ]);
      }

      await Promise.all([
        previewOutput.commit(),
        thumbnailOutput.commit(),
        fullsizeOutput ? fullsizeOutput.commit() : Promise.resolve(),
      ]);

      const decodedDimensions = { width: info.width, height: info.height };
      const fullsizeDimensions = useEdits ? getOutputDimensions(asset.edits, decodedDimensions) : decodedDimensions;

      return {
        files: fullsizeFile ? [previewFile!, thumbnailFile!, fullsizeFile] : [previewFile!, thumbnailFile!],
        thumbhash: outputs[0] as Buffer,
        fullsizeDimensions,
      };
    } finally {
      await Promise.all([
        stagedInput.cleanup(),
        previewOutput?.cleanup() ?? Promise.resolve(),
        thumbnailOutput?.cleanup() ?? Promise.resolve(),
        fullsizeOutput ? fullsizeOutput.cleanup() : Promise.resolve(),
      ]);
    }
  }

  @OnJob({ name: JobName.PersonGenerateThumbnail, queue: QueueName.ThumbnailGeneration })
  async handleGeneratePersonThumbnail({ id }: JobOf<JobName.PersonGenerateThumbnail>): Promise<JobStatus> {
    const { machineLearning, metadata, image } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning) && !isFaceImportEnabled(metadata)) {
      return JobStatus.Skipped;
    }

    const data = await this.personRepository.getDataForThumbnailGenerationJob(id);
    if (!data) {
      this.logger.error(`Could not generate person thumbnail for ${id}: missing data`);
      return JobStatus.Failed;
    }

    const { ownerId, x1, y1, x2, y2, oldWidth, oldHeight, exifOrientation, previewPath, originalPath } = data;
    let inputImage: string | Buffer;
    if (data.type === AssetType.Video) {
      if (!previewPath) {
        this.logger.error(`Could not generate person thumbnail for video ${id}: missing preview path`);
        return JobStatus.Failed;
      }
      inputImage = previewPath;
    } else if (image.extractEmbedded && mimeTypes.isRaw(originalPath)) {
      const extracted = await this.extractImage(originalPath, image.preview.size);
      inputImage = extracted ? extracted.buffer : originalPath;
    } else {
      inputImage = originalPath;
    }

    const { data: decodedImage, info } = await this.mediaRepository.decodeImage(inputImage, {
      colorspace: image.colorspace,
      processInvalidImages: false,
      // if this is an extracted image, it may not have orientation metadata
      orientation: Buffer.isBuffer(inputImage) && exifOrientation ? Number(exifOrientation) : undefined,
    });

    const thumbnailPath = StorageCore.getPersonThumbnailPath({ id, ownerId });
    this.storageCore.ensureFolders(thumbnailPath);

    const thumbnailOptions: GenerateThumbnailOptions = {
      colorspace: image.colorspace,
      format: ImageFormat.Jpeg,
      raw: info,
      quality: image.thumbnail.quality,
      progressive: false,
      processInvalidImages: false,
      size: FACE_THUMBNAIL_SIZE,
      edits: [
        {
          action: AssetEditAction.Crop,
          parameters: this.getCrop(
            { old: { width: oldWidth, height: oldHeight }, new: { width: info.width, height: info.height } },
            { x1, y1, x2, y2 },
          ),
        },
      ],
    };

    await this.mediaRepository.generateThumbnail(decodedImage, thumbnailOptions, thumbnailPath);
    await this.personRepository.update({ id, thumbnailPath });

    return JobStatus.Success;
  }

  private getCrop(
    dims: { old: ImageDimensions; new: ImageDimensions },
    { x1, y1, x2, y2 }: BoundingBox,
  ): CropParameters {
    // face bounding boxes can spill outside the image dimensions
    const clampedX1 = clamp(x1, 0, dims.old.width);
    const clampedY1 = clamp(y1, 0, dims.old.height);
    const clampedX2 = clamp(x2, 0, dims.old.width);
    const clampedY2 = clamp(y2, 0, dims.old.height);

    const widthScale = dims.new.width / dims.old.width;
    const heightScale = dims.new.height / dims.old.height;

    const halfWidth = (widthScale * (clampedX2 - clampedX1)) / 2;
    const halfHeight = (heightScale * (clampedY2 - clampedY1)) / 2;

    const middleX = Math.round(widthScale * clampedX1 + halfWidth);
    const middleY = Math.round(heightScale * clampedY1 + halfHeight);

    // zoom out 10%
    const targetHalfSize = Math.floor(Math.max(halfWidth, halfHeight) * 1.1);

    // get the longest distance from the center of the image without overflowing
    const newHalfSize = Math.min(
      middleX - Math.max(0, middleX - targetHalfSize),
      middleY - Math.max(0, middleY - targetHalfSize),
      Math.min(dims.new.width - 1, middleX + targetHalfSize) - middleX,
      Math.min(dims.new.height - 1, middleY + targetHalfSize) - middleY,
    );

    return {
      x: middleX - newHalfSize,
      y: middleY - newHalfSize,
      width: newHalfSize * 2,
      height: newHalfSize * 2,
    };
  }

  private async generateVideoThumbnails(
    asset: ThumbnailPathEntity & { originalPath: string },
    { ffmpeg, image }: SystemConfig,
  ) {
    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: image.preview.format,
      isEdited: false,
      isProgressive: false,
      isTransparent: false,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: image.thumbnail.format,
      isEdited: false,
      isProgressive: false,
      isTransparent: false,
    });
    const previewOutput = await this.stageOutputIfS3(previewFile.path);
    const thumbnailOutput = await this.stageOutputIfS3(thumbnailFile.path);

    const staged = await this.stageInputIfS3(asset.originalPath);
    let thumbhash: Buffer;
    let mainVideoStream!: VideoStreamInfo;
    try {
      const { format, audioStreams, videoStreams } = await this.mediaRepository.probe(staged.localPath);
      const videoStream = this.getMainStream(videoStreams);
      if (!videoStream) {
        throw new Error(`No video streams found for asset ${asset.id}`);
      }
      mainVideoStream = videoStream;
      const mainAudioStream = this.getMainStream(audioStreams);

      const previewConfig = ThumbnailConfig.create({ ...ffmpeg, targetResolution: image.preview.size.toString() });
      const thumbnailConfig = ThumbnailConfig.create({ ...ffmpeg, targetResolution: image.thumbnail.size.toString() });
      const previewOptions = previewConfig.getCommand(TranscodeTarget.Video, mainVideoStream, mainAudioStream, format);
      const thumbnailOptions = thumbnailConfig.getCommand(
        TranscodeTarget.Video,
        mainVideoStream,
        mainAudioStream,
        format,
      );

      this.storageCore.ensureFolders(previewOutput.localPath);
      this.storageCore.ensureFolders(thumbnailOutput.localPath);
      await this.mediaRepository.transcode(staged.localPath, previewOutput.localPath, previewOptions);
      await previewOutput.commit();
      await this.mediaRepository.transcode(staged.localPath, thumbnailOutput.localPath, thumbnailOptions);
      await thumbnailOutput.commit();

      thumbhash = await this.mediaRepository.generateThumbhash(previewOutput.localPath, {
        colorspace: image.colorspace,
        processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      });
    } finally {
      await Promise.all([staged.cleanup(), previewOutput.cleanup(), thumbnailOutput.cleanup()]);
    }

    return {
      files: [previewFile, thumbnailFile],
      thumbhash,
      fullsizeDimensions: { width: mainVideoStream.width, height: mainVideoStream.height },
    };
  }

  @OnJob({ name: JobName.AssetEncodeVideoQueueAll, queue: QueueName.VideoConversion })
  async handleQueueVideoConversion(job: JobOf<JobName.AssetEncodeVideoQueueAll>): Promise<JobStatus> {
    const { force } = job;

    let queue: { name: JobName.AssetEncodeVideo; data: { id: string } }[] = [];
    for await (const asset of this.assetJobRepository.streamForVideoConversion(force)) {
      queue.push({ name: JobName.AssetEncodeVideo, data: { id: asset.id } });

      if (queue.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(queue);
        queue = [];
      }
    }

    await this.jobRepository.queueAll(queue);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEncodeVideo, queue: QueueName.VideoConversion })
  async handleVideoConversion({ id }: JobOf<JobName.AssetEncodeVideo>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    const staged = await this.stageInputIfS3(asset.originalPath);
    const input = staged.localPath;
    const outputTarget = StorageCore.getEncodedVideoPath(asset);
    const output = await this.stageOutputIfS3(outputTarget);
    try {
      this.storageCore.ensureFolders(output.localPath);

      const { videoStreams, audioStreams, format } = await this.mediaRepository.probe(input, {
        countFrames: this.logger.isLevelEnabled(LogLevel.Debug), // makes frame count more reliable for progress logs
      });
      const videoStream = this.getMainStream(videoStreams);
      const audioStream = this.getMainStream(audioStreams);
      if (!videoStream || !format.formatName) {
        return JobStatus.Failed;
      }

      if (!videoStream.height || !videoStream.width) {
        this.logger.warn(`Skipped transcoding for asset ${asset.id}: no video streams found`);
        return JobStatus.Failed;
      }

      let { ffmpeg } = await this.getConfig({ withCache: true });
      const target = this.getTranscodeTarget(ffmpeg, videoStream, audioStream);
      if (target === TranscodeTarget.None && !this.isRemuxRequired(ffmpeg, format)) {
        const encodedVideo = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
        if (encodedVideo) {
          this.logger.log(`Transcoded video exists for asset ${asset.id}, but is no longer required. Deleting...`);
          await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [encodedVideo.path] } });
          await this.assetRepository.deleteFiles([encodedVideo]);
        } else {
          this.logger.verbose(`Asset ${asset.id} does not require transcoding based on current policy, skipping`);
        }

        return JobStatus.Skipped;
      }

      const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
      if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
        this.logger.log(`Transcoding video ${asset.id} without hardware acceleration`);
      } else {
        this.logger.log(
          `Transcoding video ${asset.id} with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and${ffmpeg.accelDecode ? '' : ' software'} decoding`,
        );
      }

      try {
        await this.mediaRepository.transcode(input, output.localPath, command);
      } catch (error: any) {
        this.logger.error(`Error occurred during transcoding: ${error.message}`);
        if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
          return JobStatus.Failed;
        }

        let partialFallbackSuccess = false;
        if (ffmpeg.accelDecode) {
          try {
            this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and software decoding`);
            ffmpeg = { ...ffmpeg, accelDecode: false };
            const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
            await this.mediaRepository.transcode(input, output.localPath, command);
            partialFallbackSuccess = true;
          } catch (error: any) {
            this.logger.error(`Error occurred during transcoding: ${error.message}`);
          }
        }

        if (!partialFallbackSuccess) {
          this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()} acceleration disabled`);
          ffmpeg = { ...ffmpeg, accel: TranscodeHardwareAcceleration.Disabled };
          const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
          await this.mediaRepository.transcode(input, output.localPath, command);
        }
      }

      this.logger.log(`Successfully encoded ${asset.id}`);

      await output.commit();
      await this.assetRepository.upsertFile({
        assetId: asset.id,
        type: AssetFileType.EncodedVideo,
        path: outputTarget,
        isEdited: false,
      });

      return JobStatus.Success;
    } finally {
      await Promise.all([staged.cleanup(), output.cleanup()]);
    }
  }

  private getMainStream<T extends VideoStreamInfo | AudioStreamInfo>(streams: T[]): T {
    return streams
      .filter((stream) => stream.codecName !== 'unknown')
      .toSorted((stream1, stream2) => stream2.bitrate - stream1.bitrate)[0];
  }

  private getTranscodeTarget(
    config: SystemConfigFFmpegDto,
    videoStream: VideoStreamInfo,
    audioStream?: AudioStreamInfo,
  ): TranscodeTarget {
    const isAudioTranscodeRequired = this.isAudioTranscodeRequired(config, audioStream);
    const isVideoTranscodeRequired = this.isVideoTranscodeRequired(config, videoStream);

    if (isAudioTranscodeRequired && isVideoTranscodeRequired) {
      return TranscodeTarget.All;
    }

    if (isAudioTranscodeRequired) {
      return TranscodeTarget.Audio;
    }

    if (isVideoTranscodeRequired) {
      return TranscodeTarget.Video;
    }

    return TranscodeTarget.None;
  }

  private isAudioTranscodeRequired(ffmpegConfig: SystemConfigFFmpegDto, stream?: AudioStreamInfo): boolean {
    if (!stream) {
      return false;
    }

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required:
      case TranscodePolicy.Optimal:
      case TranscodePolicy.Bitrate: {
        return !ffmpegConfig.acceptedAudioCodecs.includes(stream.codecName as AudioCodec);
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isVideoTranscodeRequired(ffmpegConfig: SystemConfigFFmpegDto, stream: VideoStreamInfo): boolean {
    const scalingEnabled = ffmpegConfig.targetResolution !== 'original';
    const targetRes = Number.parseInt(ffmpegConfig.targetResolution);
    const isLargerThanTargetRes = scalingEnabled && Math.min(stream.height, stream.width) > targetRes;
    const maxBitrate = this.parseBitrateToBps(ffmpegConfig.maxBitrate);
    const isLargerThanTargetBitrate = maxBitrate > 0 && stream.bitrate > maxBitrate;

    const isTargetVideoCodec = ffmpegConfig.acceptedVideoCodecs.includes(stream.codecName as VideoCodec);
    const isRequired = !isTargetVideoCodec || !stream.pixelFormat.endsWith('420p');

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required: {
        return isRequired;
      }
      case TranscodePolicy.Optimal: {
        return isRequired || isLargerThanTargetRes;
      }
      case TranscodePolicy.Bitrate: {
        return isRequired || isLargerThanTargetBitrate;
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isRemuxRequired(ffmpegConfig: SystemConfigFFmpegDto, { formatName, formatLongName }: VideoFormat): boolean {
    if (ffmpegConfig.transcode === TranscodePolicy.Disabled) {
      return false;
    }

    const formatLongNameMapping: Record<string, VideoContainer> = {
      'QuickTime / MOV': VideoContainer.Mov,
      'Matroska / WebM': VideoContainer.Webm,
    };

    const name = (formatLongName ? formatLongNameMapping[formatLongName] : undefined) ?? (formatName as VideoContainer);

    return name !== VideoContainer.Mp4 && !ffmpegConfig.acceptedContainers.includes(name);
  }

  isSRGB({
    colorspace,
    profileDescription,
    bitsPerSample,
  }: {
    colorspace: string | null;
    profileDescription: string | null;
    bitsPerSample: number | null;
  }): boolean {
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
    } else if (bitsPerSample) {
      // assume sRGB for 8-bit images with no color profile or colorspace metadata
      return bitsPerSample === 8;
    } else {
      // assume sRGB for images with no relevant metadata
      return true;
    }
  }

  private parseBitrateToBps(bitrateString: string) {
    const bitrateValue = Number.parseInt(bitrateString);

    if (Number.isNaN(bitrateValue)) {
      this.logger.log(`Maximum bitrate '${bitrateString} is not a number and will be ignored.`);
      return 0;
    }

    if (bitrateString.toLowerCase().endsWith('k')) {
      return bitrateValue * 1000; // Kilobits per second to bits per second
    } else if (bitrateString.toLowerCase().endsWith('m')) {
      return bitrateValue * 1_000_000; // Megabits per second to bits per second
    } else {
      return bitrateValue;
    }
  }

  private async shouldUseExtractedImage(extractedPathOrBuffer: string | Buffer, targetSize: number) {
    const { width, height } = await this.mediaRepository.getImageMetadata(extractedPathOrBuffer);
    const extractedSize = Math.min(width, height);
    return extractedSize >= targetSize;
  }

  private async getDevices() {
    try {
      return await this.storageRepository.readdir('/dev/dri');
    } catch {
      this.logger.debug('No devices found in /dev/dri.');
      return [];
    }
  }

  private async hasMaliOpenCL() {
    try {
      const [maliIcdStat, maliDeviceStat] = await Promise.all([
        this.storageRepository.stat('/etc/OpenCL/vendors/mali.icd'),
        this.storageRepository.stat('/dev/mali0'),
      ]);
      return maliIcdStat.isFile() && maliDeviceStat.isCharacterDevice();
    } catch {
      this.logger.debug('OpenCL not available for transcoding, so RKMPP acceleration will use CPU tonemapping');
      return false;
    }
  }

  private getS3(): S3AppStorageBackend | null {
    if (this._s3 !== undefined) {
      return this._s3;
    }
    const env = this.configRepository.getEnv();
    const s3c = env.storage.s3;
    if (env.storage.engine === 's3' && s3c && s3c.bucket) {
      this._s3 = new S3AppStorageBackend({
        endpoint: s3c.endpoint,
        region: s3c.region || 'us-east-1',
        bucket: s3c.bucket,
        prefix: s3c.prefix,
        forcePathStyle: s3c.forcePathStyle,
        useAccelerate: s3c.useAccelerate,
        accessKeyId: s3c.accessKeyId,
        secretAccessKey: s3c.secretAccessKey,
        sse: s3c.sse as any,
        sseKmsKeyId: s3c.sseKmsKeyId,
      });
    } else {
      this._s3 = null;
    }
    return this._s3;
  }

  private isS3Path(path: string): boolean {
    const s3 = this.getS3();
    return !!s3 && (path.startsWith('s3://') || StorageCore.isImmichPath(path));
  }

  private async stageInputIfS3(path: string): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
    if (!this.isS3Path(path)) {
      return { localPath: path, cleanup: async () => {} };
    }
    const s3 = this.getS3()!;
    const tmp = StorageCore.getTempPathInDir(os.tmpdir());
    await fs.mkdir(tmp.substring(0, tmp.lastIndexOf('/')), { recursive: true }).catch(() => {});
    try {
      const stream = await s3.readStream(path);
      await pipeline(stream, createWriteStream(tmp));
    } catch (error: any) {
      this.logger.error('Failed to stage S3 input', { originalPath: path, error: error?.message || error });
      throw error;
    }
    return { localPath: tmp, cleanup: () => fs.rm(tmp, { force: true }).then(() => {}) };
  }

  private async stageOutputIfS3(path: string): Promise<{
    localPath: string;
    commit: () => Promise<void>;
    cleanup: () => Promise<void>;
  }> {
    if (!this.isS3Path(path)) {
      return { localPath: path, commit: async () => {}, cleanup: async () => {} };
    }
    const s3 = this.getS3()!;
    const ext = extname(path);
    const tmpBase = StorageCore.getTempPathInDir(os.tmpdir());
    const tmp = ext ? `${tmpBase}${ext}` : tmpBase;
    await fs.mkdir(tmp.substring(0, tmp.lastIndexOf('/')), { recursive: true }).catch(() => {});
    const commit = async () => {
      const { stream, done } = await s3.writeStream(path);
      await pipeline(createReadStream(tmp), stream);
      await done();
    };
    const cleanup = () => fs.rm(tmp, { force: true }).then(() => {});
    return { localPath: tmp, commit, cleanup };
  }

  private async syncFiles(
    oldFiles: (AssetFile & { isProgressive: boolean; isTransparent: boolean })[],
    newFiles: UpsertFileOptions[],
  ) {
    const toUpsert: UpsertFileOptions[] = [];
    const pathsToDelete: string[] = [];
    const toDelete = new Set(oldFiles);

    for (const newFile of newFiles) {
      const existingFile = oldFiles.find((file) => file.type === newFile.type && file.isEdited === newFile.isEdited);
      if (existingFile) {
        toDelete.delete(existingFile);
      }

      // upsert new file path
      if (
        existingFile?.path !== newFile.path ||
        existingFile.isProgressive !== newFile.isProgressive ||
        existingFile.isTransparent !== newFile.isTransparent
      ) {
        toUpsert.push(newFile);

        // delete old file from disk
        if (existingFile && existingFile.path !== newFile.path) {
          this.logger.debug(
            `Deleting old ${newFile.type} image for asset ${newFile.assetId} in favor of a replacement`,
          );
          pathsToDelete.push(existingFile.path);
        }
      }
    }

    if (toUpsert.length > 0) {
      await this.assetRepository.upsertFiles(toUpsert);
    }

    if (toDelete.size > 0) {
      const toDeleteArray = [...toDelete];
      for (const file of toDeleteArray) {
        pathsToDelete.push(file.path);
      }
      await this.assetRepository.deleteFiles(toDeleteArray);
    }

    if (pathsToDelete.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: pathsToDelete } });
    }
  }

  private async generateEditedThumbnails(asset: ThumbnailAsset, config: SystemConfig) {
    if (asset.type !== AssetType.Image || (asset.files.length === 0 && asset.edits.length === 0)) {
      return;
    }

    const generated = asset.edits.length > 0 ? await this.generateImageThumbnails(asset, config, true) : undefined;

    const crop = asset.edits.find((e) => e.action === AssetEditAction.Crop);
    const cropBox = crop
      ? {
          x1: crop.parameters.x,
          y1: crop.parameters.y,
          x2: crop.parameters.x + crop.parameters.width,
          y2: crop.parameters.y + crop.parameters.height,
        }
      : undefined;

    const originalDimensions = getDimensions(asset.exifInfo!);
    const assetFaces = await this.personRepository.getFaces(asset.id, {});
    const ocrData = await this.ocrRepository.getByAssetId(asset.id, {});

    const faceStatuses = checkFaceVisibility(assetFaces, originalDimensions, cropBox);
    await this.personRepository.updateVisibility(faceStatuses.visible, faceStatuses.hidden);

    const ocrStatuses = checkOcrVisibility(ocrData, originalDimensions, cropBox);
    await this.ocrRepository.updateOcrVisibilities(asset.id, ocrStatuses.visible, ocrStatuses.hidden);

    return generated;
  }

  private warnOnTransparencyLoss(isTransparent: boolean, format: ImageFormat, assetId: string) {
    if (isTransparent && format === ImageFormat.Jpeg) {
      this.logger.warn(
        `Asset ${assetId} has transparency but the configured format is ${format} which does not support it, consider using a format that does, such as ${ImageFormat.Webp}`,
      );
    }
  }

  private getImageFile(
    asset: ThumbnailPathEntity,
    options: ImagePathOptions & { isProgressive: boolean; isTransparent: boolean },
  ) {
    const path = StorageCore.getImagePath(asset, options);
    return {
      assetId: asset.id,
      type: options.fileType,
      path,
      isEdited: options.isEdited,
      isProgressive: options.isProgressive,
      isTransparent: options.isTransparent,
    };
  }
}
