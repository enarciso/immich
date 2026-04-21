import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { transformException } from '@nestjs/platform-express/multer/multer/multer.utils';
import { NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { Observable } from 'rxjs';
import { StorageCore } from 'src/cores/storage.core';
import { UploadFieldName } from 'src/dtos/asset-media.dto';
import { RouteKey } from 'src/enum';
import { AuthRequest } from 'src/middleware/auth.guard';
import { ConfigRepository } from 'src/repositories/config.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { S3AppStorageBackend } from 'src/storage/s3-backend';
import { AssetMediaService } from 'src/services/asset-media.service';
import { ImmichFile, UploadFile, UploadFiles } from 'src/types';
import { asUploadRequest, mapToUploadFile } from 'src/utils/asset.util';

export function getFile(files: UploadFiles, property: 'assetData' | 'sidecarData') {
  const file = files[property]?.[0];
  return file ? mapToUploadFile(file) : file;
}

export function getFiles(files: UploadFiles) {
  return {
    file: getFile(files, 'assetData') as UploadFile,
    sidecarFile: getFile(files, 'sidecarData'),
  };
}

type ImmichMulterFile = Express.Multer.File & { uuid: string };

interface Callback<T> {
  (error: Error): void;
  (error: null, result: T): void;
}

@Injectable()
export class FileUploadInterceptor implements NestInterceptor {
  private handlers: {
    userProfile: RequestHandler;
    assetUpload: RequestHandler;
  };

  private s3: S3AppStorageBackend | null | undefined;

  constructor(
    private reflect: Reflector,
    private assetService: AssetMediaService,
    private storageRepository: StorageRepository,
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
  ) {
    this.logger.setContext(FileUploadInterceptor.name);

    const instance = multer({
      fileFilter: this.fileFilter.bind(this),
      storage: {
        _handleFile: this.handleFile.bind(this),
        _removeFile: this.removeFile.bind(this),
      },
    });

    this.handlers = {
      userProfile: instance.single(UploadFieldName.PROFILE_DATA),
      assetUpload: instance.fields([
        { name: UploadFieldName.ASSET_DATA, maxCount: 1 },
        { name: UploadFieldName.SIDECAR_DATA, maxCount: 1 },
      ]),
    };
  }

  async intercept(context: ExecutionContext, next: CallHandler<any>): Promise<Observable<any>> {
    const context_ = context.switchToHttp();
    const route = this.reflect.get<string>(PATH_METADATA, context.getClass());

    const handler: RequestHandler | null = this.getHandler(route as RouteKey);
    if (handler) {
      await new Promise<void>((resolve, reject) => {
        const next: NextFunction = (error) => (error ? reject(transformException(error)) : resolve());
        const maybePromise = handler(context_.getRequest(), context_.getResponse(), next);
        Promise.resolve(maybePromise).catch((error) => reject(error));
      });
    } else {
      this.logger.warn(`Skipping invalid file upload route: ${route}`);
    }

    return next.handle();
  }

  private getS3(): S3AppStorageBackend | null {
    if (this.s3 !== undefined) {
      return this.s3;
    }

    const env = this.configRepository.getEnv();
    const s3 = env.storage.s3;

    if (env.storage.engine === 's3' && s3?.bucket) {
      this.s3 = new S3AppStorageBackend({
        endpoint: s3.endpoint,
        region: s3.region || 'us-east-1',
        bucket: s3.bucket,
        prefix: s3.prefix,
        forcePathStyle: s3.forcePathStyle,
        useAccelerate: s3.useAccelerate,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        sse: s3.sse as any,
        sseKmsKeyId: s3.sseKmsKeyId,
      });
    } else {
      this.s3 = null;
    }

    return this.s3;
  }

  private joinUploadPath(folder: string, filename: string): string {
    if (folder.startsWith('s3://')) {
      return `${folder.replace(/\/+$/g, '')}/${filename.replace(/^\/+/g, '')}`;
    }

    return join(folder, filename);
  }

  private isS3Path(path: string): boolean {
    const s3 = this.getS3();
    return path.startsWith('s3://') || (!!s3 && StorageCore.isImmichPath(path));
  }

  private fileFilter(request: AuthRequest, file: Express.Multer.File, callback: multer.FileFilterCallback) {
    try {
      callback(null, this.assetService.canUploadFile(asUploadRequest(request, file)));
    } catch (error: Error | any) {
      callback(error);
    }
  }

  private handleFile(request: AuthRequest, file: Express.Multer.File, callback: Callback<Partial<ImmichFile>>) {
    request.on('error', (error) => {
      this.logger.warn('Request error while uploading file, cleaning up', error);
      this.assetService.onUploadError(request, file).catch(this.logger.error);
    });

    try {
      (file as ImmichMulterFile).uuid = randomUUID();

      const uploadRequest = asUploadRequest(request, file);
      const path = this.joinUploadPath(
        this.assetService.getUploadFolder(uploadRequest),
        this.assetService.getUploadFilename(uploadRequest),
      );
      const hash = file.fieldname === UploadFieldName.ASSET_DATA ? createHash('sha1') : null;
      let size = 0;
      const accountingStream = new Transform({
        transform: (chunk: Buffer, _encoding, next) => {
          hash?.update(chunk);
          size += chunk.length;
          next(null, chunk);
        },
      });

      if (this.isS3Path(path)) {
        const s3 = this.getS3();
        if (!s3) {
          return callback(new Error('S3 storage is not configured'));
        }

        s3
          .writeStream(path)
          .then(({ stream, done }) => {
            pipeline(file.stream, accountingStream, stream, async (error) => {
              if (error) {
                hash?.destroy();
                return callback(error);
              }

              try {
                await done();
                callback(null, {
                  path,
                  size,
                  checksum: hash?.digest(),
                });
              } catch (error: Error | any) {
                hash?.destroy();
                callback(error);
              }
            });
          })
          .catch((error) => callback(error));
        return;
      }

      const writeStream = this.storageRepository.createWriteStream(path);
      pipeline(file.stream, accountingStream, writeStream, (error) => {
        if (error) {
          hash?.destroy();
          return callback(error);
        }

        callback(null, {
          path,
          size,
          checksum: hash?.digest(),
        });
      });
    } catch (error: Error | any) {
      callback(error);
    }
  }

  private removeFile(_request: AuthRequest, file: Express.Multer.File, callback: (error: Error | null) => void) {
    if (this.isS3Path(file.path)) {
      const s3 = this.getS3();
      if (!s3) {
        callback(null);
        return;
      }

      s3
        .deleteObject(file.path)
        .then(() => callback(null))
        .catch(callback);
      return;
    }

    this.storageRepository
      .unlink(file.path)
      .then(() => callback(null))
      .catch(callback);
  }

  private getHandler(route: RouteKey) {
    switch (route) {
      case RouteKey.Asset: {
        return this.handlers.assetUpload;
      }

      case RouteKey.User: {
        return this.handlers.userProfile;
      }

      default: {
        return null;
      }
    }
  }
}
