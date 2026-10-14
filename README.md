# CrimeStats USA

CrimeStats USA is an Android app that puts official US figures side by side for
every state and 12 metro areas: violent and property crime (FBI), median
household income (Census), unemployment and inflation (BLS), overdose and other
death rates (CDC), and the 2024 presidential result. Every number carries its
source and year.

**This repository is where problem reports go.** The app's code is not public
yet. When it is published, it will move into this repository, so reports and
code live in one place and nothing filed here is lost.

## Data

The app's figures are refreshed every Monday by the **Refresh data** job
(`.github/workflows/refresh-data.yml`) on GitHub's computers, from the FBI,
the Census Bureau, BLS, CDC, ICE, USDA and Planned Parenthood's directory.
The result is published as `data/crimestats-data.json` and signed
(`data/crimestats-data.json.sig`), so the app can tell the official file from
any other. `data/status.json` shows when the job last ran and what each source
did. Every figure is checked before it is published; a source that fails keeps
its previous values.

**Run your own copy** so the app keeps working without this repository:
[RUN-YOUR-OWN.md](RUN-YOUR-OWN.md). The app labels any other source with its
own address and never shows it as the official data.

## Reporting a crash or problem

**From the app (preferred).**
1. Open *About the data* and switch on **Keep a crash log on this phone**.
2. When something goes wrong, come back to *About the data* and tap
   **Report on GitHub**. It opens a new issue here, already filled in with the
   errors and the phone details.
3. Read it, edit or delete anything you like, then submit it from your own
   GitHub account.

Nothing is ever sent automatically, and the app holds no GitHub token.

**By hand.** Choose **New issue** and pick a template.

## What a report contains

The app version, the phone model, the Android and WebView versions, the screen
size, the text size, the theme, the language, and the errors with the screen
each happened on.

It never contains your favourites, saved views, searches or anything you typed.
The crash log stays on the phone until you send it, and switching it off deletes
it.

## A number looks wrong

Use the **Wrong or outdated figure** template. Say which place, which number,
and what source you are comparing it against.
