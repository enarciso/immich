A command-line interface for interfacing with the self-hosted photo manager [Immich](https://immich.app/).

Please see the [Immich CLI documentation](https://immich.app/docs/features/command-line-interface).

# Storage migration to S3

The CLI provides helpers to plan, run, and verify a local-to-S3 migration of your Immich media directory.

Print suggested commands (aws and s5cmd):

    $ immich storage s3-plan --media-base /path/to/immich/media --bucket my-bucket --prefix immich

Run the migration (auto-detects tool, prefers s5cmd):

    $ immich storage s3-migrate --media-base /path/to/immich/media --bucket my-bucket --prefix immich --dry-run
    # remove --dry-run when satisfied; adjust concurrency via --concurrency for s5cmd

Verify assets reference S3 after switching the storage engine:

    $ immich login <url> <api-key>
    $ immich storage s3-verify --sample 200 --expect-prefix s3://my-bucket/immich

Notes:

- Run `s3-plan` and `s3-migrate` on the server host (where the media directory is accessible).
- Requires either the AWS CLI (`aws`) or `s5cmd` to be installed. No SDK dependencies are bundled in the CLI.
- `--media-base` can be provided via `IMMICH_MEDIA_LOCATION`; `--bucket`/`--prefix` via `S3_BUCKET`/`S3_PREFIX`.
- Switch Immich to S3 storage via server configuration separately, then use `s3-verify` to confirm.

# For developers

Before building the CLI, you must build the immich server and the open-api client. To build the server run the following in the server folder:

    $ npm install
    $ npm run build

Then, to build the open-api client run the following in the open-api folder:

    $ ./bin/generate-open-api.sh

To run the Immich CLI from source, run the following in the cli folder:

    $ npm install
    $ npm run build
    $ ts-node .

You'll need ts-node, the easiest way to install it is to use npm:

    $ npm i -g ts-node

You can also build and install the CLI using

    $ npm run build
    $ npm install -g .
****
