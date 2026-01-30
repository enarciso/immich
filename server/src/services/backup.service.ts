import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DateTime } from 'luxon';
import { serverVersion } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import { DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName, StorageFolder } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import {
  buildPostgresLaunchArguments,
  createDatabaseBackup,
  isFailedDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
  UnsupportedPostgresError,
} from 'src/utils/database-backups';
import { handlePromiseError } from 'src/utils/misc';
import { S3AppStorageBackend } from 'src/storage/s3-backend';

@Injectable()
export class BackupService extends BaseService {
  private backupLock = false;
  // S3 helpers
  private _s3: S3AppStorageBackend | null | undefined;
  private joinPaths(base: string, part: string): string {
    if (base.startsWith('s3://')) {
      const head = base.replace(/\/+$/g, '');
      const tail = part.replace(/^\/+/, '');
      return `${head}/${tail}`;
    }
    return path.join(base, part);
  }
  private getS3(): S3AppStorageBackend | null {
    if (this._s3 !== undefined) return this._s3;
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

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      backup: { database },
    },
  }: ArgOf<'ConfigInit'>) {
    this.backupLock = await this.databaseRepository.tryLock(DatabaseLock.BackupDatabase);

    if (this.backupLock) {
      this.cronRepository.create({
        name: 'backupDatabase',
        expression: database.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.DatabaseBackup }), this.logger),
        start: database.enabled,
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { backup } }: ArgOf<'ConfigUpdate'>) {
    if (!this.backupLock) {
      return;
    }

    this.cronRepository.update({
      name: 'backupDatabase',
      expression: backup.database.cronExpression,
      start: backup.database.enabled,
    });
  }

  async cleanupDatabaseBackups() {
    this.logger.debug(`Database Backup Cleanup Started`);
    const {
      backup: { database: config },
    } = await this.getConfig({ withCache: false });

    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const s3 = this.getS3();
    const files =
      s3 && (backupsFolder.startsWith('s3://') || StorageCore.isImmichPath(backupsFolder))
        ? await s3.list(backupsFolder)
        : await this.storageRepository.readdir(backupsFolder);
    const backups = files
      .filter((filename) => isValidDatabaseRoutineBackupName(filename))
      .toSorted()
      .toReversed();
    const failedBackups = files.filter((filename) => isFailedDatabaseBackupName(filename));

    const toDelete = backups.slice(config.keepLastAmount);
    toDelete.push(...failedBackups);

    for (const file of toDelete) {
      const filePath = this.joinPaths(backupsFolder, file);
      if (s3 && (filePath.startsWith('s3://') || StorageCore.isImmichPath(filePath))) {
        await s3.deleteObject(filePath);
      } else {
        await this.storageRepository.unlink(filePath);
      }
    }
    this.logger.debug(`Database Backup Cleanup Finished, deleted ${toDelete.length} backups`);
  }

  @OnJob({ name: JobName.DatabaseBackup, queue: QueueName.BackupDatabase })
  async handleBackupDatabase(): Promise<JobStatus> {
    try {
      const backupsFolder = StorageCore.getBaseFolder(StorageFolder.Backups);
      const s3 = this.getS3();
      if (s3 && (backupsFolder.startsWith('s3://') || StorageCore.isImmichPath(backupsFolder))) {
        await this.createDatabaseBackupInS3(s3, backupsFolder);
      } else {
        await createDatabaseBackup(this.backupRepos);
      }
    } catch (error) {
      if (error instanceof UnsupportedPostgresError) {
        return JobStatus.Failed;
      }
      throw error;
    }

    await this.cleanupDatabaseBackups();
    return JobStatus.Success;
  }

  private get backupRepos() {
    return {
      logger: this.logger,
      storage: this.storageRepository,
      config: this.configRepository,
      process: this.processRepository,
      database: this.databaseRepository,
    };
  }

  private async createDatabaseBackupInS3(s3: S3AppStorageBackend, backupsFolder: string) {
    this.logger.debug(`Database Backup Started`);

    const { bin, args, databasePassword, databaseVersion, databaseMajorVersion } = await buildPostgresLaunchArguments(
      { logger: this.logger, config: this.configRepository, database: this.databaseRepository },
      'pg_dump',
    );

    this.logger.log(`Database Backup Starting. Database Version: ${databaseMajorVersion}`);

    const filename = `immich-db-backup-${DateTime.now().toFormat("yyyyLLdd'T'HHmmss")}-v${serverVersion.toString()}-pg${
      databaseVersion.split(' ')[0]
    }.sql.gz`;
    const backupFilePath = this.joinPaths(backupsFolder, filename);
    const temporaryFilePath = `${backupFilePath}.tmp`;

    try {
      const pgdump = this.processRepository.spawnDuplexStream(bin, args, {
        env: {
          PATH: process.env.PATH,
          PGPASSWORD: databasePassword,
        },
      });
      const gzip = this.processRepository.spawnDuplexStream('gzip', ['--rsyncable']);
      const { stream, done } = await s3.writeStream(temporaryFilePath);
      await pipeline(pgdump, gzip, stream);
      await done();

      await s3.copyObject(temporaryFilePath, backupFilePath);
      await s3.deleteObject(temporaryFilePath);
      this.logger.log(`Database Backup Success`);
    } catch (error) {
      this.logger.error(`Database Backup Failure: ${error}`);
      await s3
        .deleteObject(temporaryFilePath)
        .catch((err) => this.logger.error(`Failed to delete failed backup object: ${err}`));
      throw error;
    }
  }
}
