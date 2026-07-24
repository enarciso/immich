import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { ErrorMessages } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import {
  BootstrapEventPriority,
  DatabaseLock,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { S3AppStorageBackend } from 'src/storage/s3-backend';
import { JobOf, StorageLayout, SystemFlags } from 'src/types';
import { ImmichStartupError } from 'src/utils/misc';

const docsMessage = `Please see https://docs.immich.app/administration/system-integrity#folder-checks for more information.`;
type StorageLayoutChange = { folder: StorageFolder; source: string; target: string };

@Injectable()
export class StorageService extends BaseService {
  private buildS3Location(bucket: string, prefix?: string): string {
    const normalizedPrefix = prefix?.replace(/^\/+|\/+$/g, '');
    return normalizedPrefix ? `s3://${bucket}/${normalizedPrefix}` : `s3://${bucket}`;
  }

  private getS3FolderPrefix(folder: StorageFolder): string | undefined {
    const s3 = this.configRepository.getEnv().storage.s3;
    if (!s3) {
      return;
    }

    switch (folder) {
      case StorageFolder.Thumbnails: {
        return s3.thumbPrefix;
      }
      case StorageFolder.EncodedVideo: {
        return s3.encodedVideoPrefix;
      }
      case StorageFolder.Profile: {
        return s3.profilePrefix;
      }
      case StorageFolder.Backups: {
        return s3.backupPrefix;
      }
      default: {
        return;
      }
    }
  }

  private detectMediaLocation(): string {
    const envData = this.configRepository.getEnv();
    if (envData.storage.mediaLocation) {
      return envData.storage.mediaLocation;
    }

    if (envData.storage.engine === 's3' && envData.storage.s3?.bucket) {
      return this.buildS3Location(envData.storage.s3.bucket, envData.storage.s3.prefix);
    }

    const targets: string[] = [];
    const candidates = ['/data', '/usr/src/app/upload'];

    for (const candidate of candidates) {
      const exists = this.storageRepository.existsSync(candidate);
      if (exists) {
        targets.push(candidate);
      }
    }

    if (targets.length === 1) {
      return targets[0];
    }

    return '/usr/src/app/upload';
  }

  private detectStorageLayout(): StorageLayout {
    const envData = this.configRepository.getEnv();
    const mediaLocation = this.detectMediaLocation();
    const folders = Object.fromEntries(
      Object.values(StorageFolder).map((folder) => {
        const overridePrefix =
          envData.storage.engine === 's3' && envData.storage.s3?.bucket ? this.getS3FolderPrefix(folder) : undefined;
        const location =
          overridePrefix && envData.storage.s3?.bucket
            ? this.buildS3Location(envData.storage.s3.bucket, overridePrefix)
            : StorageCore.joinPaths(mediaLocation, folder);
        return [folder, location];
      }),
    ) as Record<StorageFolder, string>;

    return { mediaLocation, folders };
  }

  private getLegacyStorageLayout(currentLayout: StorageLayout, previousMediaLocation?: string | null): StorageLayout {
    let mediaLocation = previousMediaLocation || '';
    if (!mediaLocation && this.configRepository.getEnv().storage.mediaLocation) {
      mediaLocation = currentLayout.mediaLocation;
    }
    if (!mediaLocation) {
      mediaLocation = currentLayout.mediaLocation;
    }

    return {
      mediaLocation,
      folders: Object.fromEntries(
        Object.values(StorageFolder).map((folder) => [folder, StorageCore.joinPaths(mediaLocation, folder)]),
      ) as Record<StorageFolder, string>,
    };
  }

  private getS3StorageBackend(): S3AppStorageBackend | null {
    const s3 = this.configRepository.getEnv().storage.s3;
    if (this.configRepository.getEnv().storage.engine !== 's3' || !s3?.bucket) {
      return null;
    }

    return new S3AppStorageBackend({
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
  }

  private getStorageLayoutChanges(previousLayout: StorageLayout, currentLayout: StorageLayout): StorageLayoutChange[] {
    return Object.values(StorageFolder)
      .map((folder) => ({
        folder,
        source: previousLayout.folders[folder],
        target: currentLayout.folders[folder],
      }))
      .filter(({ source, target }) => source !== target);
  }

  private async migrateS3FolderObjects(s3: S3AppStorageBackend, sourceRoot: string, targetRoot: string): Promise<void> {
    if (sourceRoot === targetRoot) {
      return;
    }

    const relativePaths = await s3.listRecursive(sourceRoot);
    for (const relativePath of relativePaths) {
      const sourcePath = StorageCore.joinPaths(sourceRoot, relativePath);
      const targetPath = StorageCore.joinPaths(targetRoot, relativePath);
      const sourceHead = await s3.head(sourcePath);
      const targetExists = await s3.exists(targetPath);

      if (!targetExists) {
        await s3.copyObject(sourcePath, targetPath);
      }

      const targetHead = await s3.head(targetPath);
      if (Number(sourceHead.size) !== Number(targetHead.size)) {
        throw new Error(`S3 migration verification failed for ${targetPath}: ${targetHead.size} !== ${sourceHead.size}`);
      }

      await s3.deleteObject(sourcePath);
    }
  }

  private async migrateS3StorageLayout(previousLayout: StorageLayout, currentLayout: StorageLayout): Promise<void> {
    const changes = this.getStorageLayoutChanges(previousLayout, currentLayout);
    if (changes.length === 0) {
      return;
    }

    const s3 = this.getS3StorageBackend();
    if (!s3) {
      throw new Error('S3 storage backend is not configured');
    }

    this.logger.warn(
      `Detected a change to managed S3 storage layout, performing an automatic migration for folders: ${changes
        .map(({ folder }) => folder)
        .join(', ')}`,
    );

    for (const change of changes) {
      this.logger.log(
        `Migrating S3 managed folder ${change.folder} (from=${change.source}, to=${change.target})`,
      );
      await this.migrateS3FolderObjects(s3, change.source, change.target);
      await this.databaseRepository.migrateStorageFolderPaths(change.folder, change.source, change.target);
    }
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageService })
  async onBootstrap() {
    StorageCore.setStorageLayout(this.detectStorageLayout());

    await this.databaseRepository.withLock(DatabaseLock.SystemFileMounts, async () => {
      const flags =
        (await this.systemMetadataRepository.get(SystemMetadataKey.SystemFlags)) ||
        ({ mountChecks: {} } as SystemFlags);

      if (!flags.mountChecks) {
        flags.mountChecks = {};
      }

      let updated = false;

      this.logger.log(`Verifying system mount folder checks, current state: ${JSON.stringify(flags)}`);

      // For S3 storage engine, skip filesystem mount checks and mark as passed
      if (this.configRepository.getEnv().storage.engine === 's3') {
        for (const folder of Object.values(StorageFolder)) {
          if (!flags.mountChecks[folder]) {
            flags.mountChecks[folder] = true;
            updated = true;
          }
        }
        if (updated) {
          await this.systemMetadataRepository.set(SystemMetadataKey.SystemFlags, flags);
          this.logger.log('Skipping mount checks for S3 engine and marking as verified');
        }
        return;
      }

      try {
        // check each folder exists and is writable
        for (const folder of Object.values(StorageFolder)) {
          if (!flags.mountChecks[folder]) {
            this.logger.log(`Writing initial mount file for the ${folder} folder`);
            await this.createMountFile(folder);
          }

          await this.verifyReadAccess(folder);
          await this.verifyWriteAccess(folder);

          if (!flags.mountChecks[folder]) {
            flags.mountChecks[folder] = true;
            updated = true;
          }
        }

        if (updated) {
          await this.systemMetadataRepository.set(SystemMetadataKey.SystemFlags, flags);
          this.logger.log('Successfully enabled system mount folders checks');
        }

        this.logger.log('Successfully verified system mount folder checks');
      } catch (error) {
        const envData = this.configRepository.getEnv();
        if (envData.storage.ignoreMountCheckErrors) {
          this.logger.error(error as Error);
          this.logger.warn('Ignoring mount folder errors');
        } else {
          throw error;
        }
      }
    });

    await this.databaseRepository.withLock(DatabaseLock.MediaLocation, async () => {
      const currentLayout = StorageCore.getStorageLayout();
      const current = currentLayout.mediaLocation;
      const savedValue = await this.systemMetadataRepository.get(SystemMetadataKey.MediaLocation);
      const savedLayout = await this.systemMetadataRepository.get(SystemMetadataKey.StorageLayout);

      if (this.configRepository.getEnv().storage.engine === 's3') {
        const previousLayout = savedLayout || this.getLegacyStorageLayout(currentLayout, savedValue?.location);
        await this.migrateS3StorageLayout(previousLayout, currentLayout);
      } else {
        const samples = await this.assetRepository.getFileSamples();
        if (samples.length > 0) {
          const path = samples[0].path;

          let previous = savedValue?.location || '';

          if (!previous && this.configRepository.getEnv().storage.mediaLocation) {
            previous = current;
          }

          if (!previous) {
            previous = path.startsWith('upload/') ? 'upload' : '/usr/src/app/upload';
          }

          if (previous !== current) {
            this.logger.log(`Media location changed (from=${previous}, to=${current})`);

            if (!path.startsWith(previous)) {
              throw new Error(ErrorMessages.InconsistentMediaLocation);
            }

            this.logger.warn(
              `Detected a change to media location, performing an automatic migration of file paths from ${previous} to ${current}, this may take awhile`,
            );
            await this.databaseRepository.migrateFilePaths(previous, current);
          }
        }
      }

      if (savedValue?.location !== current) {
        await this.systemMetadataRepository.set(SystemMetadataKey.MediaLocation, { location: current });
      }

      if (JSON.stringify(savedLayout) !== JSON.stringify(currentLayout)) {
        await this.systemMetadataRepository.set(SystemMetadataKey.StorageLayout, currentLayout);
      }
    });
  }

  @OnJob({ name: JobName.FileDelete, queue: QueueName.BackgroundTask })
  async handleDeleteFiles(job: JobOf<JobName.FileDelete>): Promise<JobStatus> {
    const { files } = job;

    // TODO: one job per file
    const env = this.configRepository.getEnv();
    const engine = env.storage.engine || 'local';
    const s3c = env.storage.s3;
    const useS3 = engine === 's3' && s3c && s3c.bucket;
    const s3 = useS3
      ? new S3AppStorageBackend({
          endpoint: s3c.endpoint,
          region: s3c.region || 'us-east-1',
          bucket: s3c.bucket!,
          prefix: s3c.prefix,
          forcePathStyle: s3c.forcePathStyle,
          useAccelerate: s3c.useAccelerate,
          accessKeyId: s3c.accessKeyId,
          secretAccessKey: s3c.secretAccessKey,
          sse: s3c.sse as any,
          sseKmsKeyId: s3c.sseKmsKeyId,
        })
      : null;

    for (const file of files) {
      if (!file) {
        continue;
      }

      try {
        if (s3 && (file.startsWith('s3://') || StorageCore.isImmichPath(file))) {
          await s3.deleteObject(file);
        } else {
          await this.storageRepository.unlink(file);
        }
      } catch (error: any) {
        this.logger.warn('Unable to remove file from disk', error);
      }
    }

    return JobStatus.Success;
  }

  private async verifyReadAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.readFile(internalPath);
    } catch (error) {
      this.logger.error(`Failed to read (${internalPath}): ${error}`);
      throw new ImmichStartupError(`Failed to read: "${externalPath} (${internalPath}) - ${docsMessage}"`);
    }
  }

  private async createMountFile(folder: StorageFolder) {
    const { folderPath, internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      this.storageRepository.mkdirSync(folderPath);
      await this.storageRepository.createFile(internalPath, Buffer.from(`${Date.now()}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.warn('Found existing mount file, skipping creation');
        return;
      }
      this.logger.error(`Failed to create ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to create "${externalPath} - ${docsMessage}"`);
    }
  }

  private async verifyWriteAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.overwriteFile(internalPath, Buffer.from(`${Date.now()}`));
    } catch (error) {
      this.logger.error(`Failed to write ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to write "${externalPath} - ${docsMessage}"`);
    }
  }

  private getMountFilePaths(folder: StorageFolder) {
    const folderPath = StorageCore.getBaseFolder(folder);
    const internalPath = join(folderPath, '.immich');
    const externalPath = `<UPLOAD_LOCATION>/${folder}/.immich`;

    return { folderPath, internalPath, externalPath };
  }
}
