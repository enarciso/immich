import { searchLargeAssets } from '@immich/sdk';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { BaseOptions, authenticate, logError, withError } from 'src/utils';

type Tool = 'aws' | 's5cmd' | 'both' | 'auto';

export interface S3PlanOptionsDto {
  mediaBase?: string;
  bucket?: string;
  prefix?: string;
  profile?: string;
  tool?: Tool;
}

export interface S3MigrateOptionsDto extends S3PlanOptionsDto {
  dryRun?: boolean;
  concurrency?: number;
  tool?: Tool;
}

export interface S3VerifyOptionsDto {
  sample?: number;
  expectPrefix?: string;
}

export const storageS3Plan = async (_base: BaseOptions, options: S3PlanOptionsDto) => {
  const mediaBase = options.mediaBase ?? process.env.IMMICH_MEDIA_LOCATION ?? '';
  const bucket = options.bucket ?? process.env.S3_BUCKET ?? '';
  const prefix = (options.prefix ?? process.env.S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const profile = options.profile ?? process.env.AWS_PROFILE;
  const tool = (options.tool ?? 'both') as Tool;

  if (!mediaBase) {
    console.error('Missing --media-base (or IMMICH_MEDIA_LOCATION).');
    return process.exit(1);
  }
  if (!bucket) {
    console.error('Missing --bucket (or S3_BUCKET).');
    return process.exit(1);
  }

  const normalizedMediaBase = path.resolve(mediaBase) + path.sep;
  const s3Uri = `s3://${bucket}${prefix ? '/' + prefix : ''}/`;

  console.log('S3 Migration Plan');
  console.log(`  Media base (server host): ${normalizedMediaBase}`);
  console.log(`  Destination: ${s3Uri}`);
  if (profile) {
    console.log(`  AWS profile: ${profile}`);
  }

  if (tool === 'aws' || tool === 'both') {
    console.log('\nAWS CLI:');
    const profileArg = profile ? ` --profile ${profile}` : '';
    console.log(
      `  aws s3 sync "${normalizedMediaBase}" "${s3Uri}" --only-show-errors${profileArg}`,
    );
  }

  if (tool === 's5cmd' || tool === 'both') {
    console.log('\ns5cmd:');
    // Use 32 workers as a reasonable default; tune as needed
    console.log(`  s5cmd --numworkers 32 sync "${normalizedMediaBase}" "${s3Uri}"`);
  }

  console.log('\nNotes:');
  console.log(
    '  - Run these on the server host where the media directory is accessible.',
  );
  console.log('  - Add dry-run flags first to preview (aws: --dryrun, s5cmd: -n).');
  console.log('  - For large sets, consider multiple passes and verify afterward.');
};

export const storageS3Migrate = async (_base: BaseOptions, options: S3MigrateOptionsDto) => {
  const mediaBase = options.mediaBase ?? process.env.IMMICH_MEDIA_LOCATION ?? '';
  const bucket = options.bucket ?? process.env.S3_BUCKET ?? '';
  const prefix = (options.prefix ?? process.env.S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  const profile = options.profile ?? process.env.AWS_PROFILE;
  const dryRun = Boolean(options.dryRun);
  const tool = (options.tool ?? 'auto') as Tool;
  const concurrency = Number.isFinite(Number(options.concurrency))
    ? Number(options.concurrency)
    : undefined;

  if (!mediaBase) {
    console.error('Missing --media-base (or IMMICH_MEDIA_LOCATION).');
    return process.exit(1);
  }
  if (!bucket) {
    console.error('Missing --bucket (or S3_BUCKET).');
    return process.exit(1);
  }

  const normalizedMediaBase = path.resolve(mediaBase) + path.sep;
  const s3Uri = `s3://${bucket}${prefix ? '/' + prefix : ''}/`;

  const resolvedTool = selectTool(tool);
  if (!resolvedTool) {
    console.error(
      'No supported tool found. Install AWS CLI (aws) or s5cmd, or pass --tool aws|s5cmd.',
    );
    return process.exit(1);
  }

  if (resolvedTool === 'aws') {
    const args = ['s3', 'sync', normalizedMediaBase, s3Uri, '--only-show-errors'];
    if (dryRun) args.push('--dryrun');
    const env = { ...process.env, ...(profile ? { AWS_PROFILE: profile } : {}) };
    const { status } = spawnSync('aws', args, { stdio: 'inherit', env });
    process.exit(status ?? 1);
  }

  if (resolvedTool === 's5cmd') {
    const args: string[] = [];
    if (concurrency) {
      args.push('--numworkers', String(concurrency));
    }
    if (dryRun) {
      args.push('-n');
    }
    args.push('sync', normalizedMediaBase, s3Uri);
    const { status } = spawnSync('s5cmd', args, { stdio: 'inherit' });
    process.exit(status ?? 1);
  }
};

export const storageS3Verify = async (base: BaseOptions, options: S3VerifyOptionsDto) => {
  await authenticate(base);

  const sample = Math.max(1, Number(options.sample ?? 100));
  const expectPrefix = (options.expectPrefix ?? '').trim();

  const [error, result] = await withError(
    // Use searchLargeAssets to fetch a sample set of assets
    searchLargeAssets({ size: sample, withDeleted: false }),
  );
  if (error) {
    logError(error, 'Failed to query assets for verification');
    return process.exit(1);
  }

  const assets = result;
  if (!Array.isArray(assets) || assets.length === 0) {
    console.log('No assets returned for verification.');
    return;
  }

  let s3Count = 0;
  let matchPrefix = 0;
  for (const a of assets) {
    if (a.originalPath?.startsWith('s3://')) {
      s3Count++;
      if (expectPrefix && a.originalPath.startsWith(expectPrefix)) {
        matchPrefix++;
      }
    }
  }

  console.log('S3 Verification Results');
  console.log(`  Sample size: ${assets.length}`);
  console.log(`  S3-backed assets: ${s3Count}`);
  if (expectPrefix) {
    console.log(`  Matching prefix (${expectPrefix}): ${matchPrefix}`);
  }

  if (s3Count === assets.length) {
    console.log('OK: All sampled assets reference s3:// paths.');
  } else {
    console.log('WARN: Some sampled assets still reference local paths.');
  }
};

function selectTool(tool: Tool): 'aws' | 's5cmd' | undefined {
  if (tool === 'aws' || tool === 's5cmd') return tool;
  if (tool === 'both') return hasCmd('s5cmd') ? 's5cmd' : hasCmd('aws') ? 'aws' : undefined;
  // auto: prefer s5cmd if available
  return hasCmd('s5cmd') ? 's5cmd' : hasCmd('aws') ? 'aws' : undefined;
}

function hasCmd(cmd: string): boolean {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !probe.error && (probe.status === 0 || probe.status === 1);
}

