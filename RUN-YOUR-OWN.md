# Run your own CrimeStats data source

The CrimeStats app gets its figures from one data file that is refreshed every
week from the FBI, the Census Bureau, BLS, CDC, ICE, USDA and Planned
Parenthood's directory. This kit lets you publish that file yourself, on your
own GitHub account, so the app keeps working even if the official source ever
stops. It takes about ten minutes and costs nothing. No API key is needed.

In the app, your source is always labelled with its own address. It is never
shown as the official CrimeStats data.

## What you need

- A free GitHub account: https://github.com/signup
- This kit, unzipped. (In the app: *About the data*, then **Export the data kit**.)

## Steps

1. **Create a new repository.** On GitHub, press **+**, then **New repository**.
   Give it any name, for example `my-crimestats-data`, choose **Public**, and
   press **Create repository**. Don't add a README; the kit has its own.
2. **Upload the kit.** On the new repository's page, choose
   **uploading an existing file**. Drag in everything from the unzipped kit:
   the `job` and `data` folders and the files `README.md` and
   `RUN-YOUR-OWN.md`. Then press **Commit changes**.
3. **Add the weekly job.** Some browsers skip folders whose names start with a
   dot when you drag them in, so add this file by hand. Press **Add file**, then
   **Create new file**. Type the name `.github/workflows/refresh-data.yml` (the
   slashes make the folders). Open `refresh-data.yml` from the kit in a text
   editor, copy everything, paste it in, and press **Commit changes**.
4. **Run it once.** Open the **Actions** tab. If GitHub asks, press
   **I understand my workflows, go ahead and enable them**. Choose
   **Refresh data** on the left, then **Run workflow**. It takes a few minutes.
   A green tick means it worked. From now on it runs every Monday by itself.
5. **Point the app at it.** Your data address is:

   `https://raw.githubusercontent.com/YOUR-NAME/YOUR-REPOSITORY/main/data/crimestats-data.json`

   with your GitHub name and repository name filled in. In the app, open
   *About the data*, paste the address under **Use another data source**, and
   press **Use this source**. To go back, press **Back to the official source**.

## If something goes wrong

- **The run failed with "Permission denied" when pushing.** Open the repository's
  **Settings**, then **Actions**, then **General**. Under **Workflow permissions**,
  choose **Read and write permissions** and save. Then run it again.
- **One source failed.** Open `data/status.json`. It lists every source with
  `ok` or `failed` and the reason. A failed source keeps its previous figures.
  ice.gov sometimes refuses downloads from GitHub's computers. If ICE keeps
  failing, download the newest workbook from
  https://www.ice.gov/detain/detention-management in a browser and run
  `node job/scripts/refresh-data.mjs --ice-file <the workbook>` on your own
  computer (Node.js 20 or newer), then upload `job/src/live-baked.js` and
  run `node job/scripts/publish-data.mjs`.
- **The schedule stopped.** GitHub pauses scheduled jobs in a repository with
  no activity for 60 days. The job commits `data/status.json` every week, which
  normally prevents that. If it does stop, open the **Actions** tab and turn it
  back on.

## Optional

- **A BLS key** raises the Bureau of Labor Statistics' daily allowance. It is free
  at https://data.bls.gov/registrationEngine/. Add it under **Settings**, then
  **Secrets and variables**, then **Actions**, as a secret named `BLS_API_KEY`.
- **Signing** is only used by the official source, so that the app can recognise
  it. Leave `CRIMESTATS_SIGNING_KEY` unset. Your data works without it.

## Licence

The kit is free software under the Apache License 2.0 (`LICENSE`, `NOTICE`):
you may use, change and share it, keeping those two files with it. The
licence does not cover the names "CrimeStats" and "CrimeStats USA"; your
source must not present itself as the official CrimeStats data, and the app
always labels it with its own address.

## What is in the kit

| Path | What it is |
|---|---|
| `job/scripts/refresh-data.mjs` | Fetches every source and hands the raw data to the checks |
| `job/scripts/refresh-core.mjs` | The checks and the merge; writes nothing unless everything validates |
| `job/scripts/publish-data.mjs` | Copies the result to `data/`, signs it if a key is set, writes `data/status.json` |
| `job/src/` | The base data and the validation rules the app itself uses |
| `data/crimestats-data.json` | The published file. The kit starts with a copy of the official data |
| `refresh-data.yml` | The weekly job (goes in `.github/workflows/`) |
| `LICENSE`, `NOTICE` | The Apache License 2.0 and the project's notice; keep them with the files |
