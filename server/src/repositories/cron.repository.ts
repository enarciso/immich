import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { LoggingRepository } from 'src/repositories/logging.repository';

type CronBase = {
  name: string;
  start?: boolean;
};

export type CronCreate = CronBase & {
  expression: string;
  onTick: () => void;
};

export type CronUpdate = CronBase & {
  expression?: string;
};

@Injectable()
export class CronRepository {
  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CronRepository.name);
  }

  create({ name, expression, onTick, start = true }: CronCreate): void {
    const job = new CronJob<null, null>(
      expression,
      onTick,
      // function to run onComplete
      undefined,
      // whether it should start directly
      start,
      // timezone
      undefined,
      // context
      undefined,
      // runOnInit
      undefined,
      // utcOffset
      undefined,
      // prevents memory leaking by automatically stopping when the node process finishes
      true,
    );

    // `@nestjs/schedule` currently types SchedulerRegistry with its own `cron` dependency version.
    // Bridge the type here so our direct `cron` import does not fail on private-type mismatches.
    this.schedulerRegistry.addCronJob(name, job as unknown as Parameters<SchedulerRegistry['addCronJob']>[1]);
  }

  update({ name, expression, start }: CronUpdate): void {
    const job = this.schedulerRegistry.getCronJob(name);
    if (expression) {
      job.setTime(new CronTime(expression) as unknown as Parameters<typeof job.setTime>[0]);
    }
    if (start !== undefined) {
      if (start) {
        job.start();
      } else {
        void job.stop();
      }
    }
  }
}
