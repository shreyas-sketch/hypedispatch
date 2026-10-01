# Hype Dispatch

Auto-sends daily messages to your workshop WhatsApp communities, written by Claude **only from each workshop's landing page**.

| When | What goes out | Links |
|---|---|---|
| 2+ days before | Hype message (new angle each day, never a countdown) | Bonus form |
| 1 day before | "Dropping tomorrow" | Bonus form + Zoom |
| Workshop day | "We're live today" (can be switched off per workshop) | Zoom only |
| Rescheduled | New date announcement, 5 minutes after you save it | Bonus form |

The **bonus form** is the short form that helps you tailor the workshop to each person; everyone who fills it gets a surprise bonus. Messages describe it that way and never guess what the bonus is.

## Setup (Windows, one time)

1. Install Node.js 20+ from nodejs.org.
2. Unzip this folder, open a terminal inside it, and run:
   ```
   npm install
   copy .env.example .env
   ```
3. Open `.env` and paste your Anthropic API key after `ANTHROPIC_API_KEY=`.
4. Start it so it stays on in the background:
   ```
   npm install -g pm2 pm2-windows-startup
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2-startup install
   ```
5. Open **http://localhost:4321**.

The PC must stay on and awake at send times (Settings → Power → Sleep: Never).

## Or: run it on Railway (no PC needed)

1. In Railway: **New Project → Deploy from GitHub repo** → pick this repo (and the branch you want).
2. **Attach a volume** to the service: right-click the service → **Attach volume**, mount path `/data`. Without it, every redeploy wipes your workshops and WhatsApp logins (the dashboard shows a red **Data not saved** badge until you add it).
3. Service → **Variables**, add:
   - `ANTHROPIC_API_KEY`: your key
   - `DASHBOARD_PASSWORD`: required. Until it's set, the dashboard stays locked, because anyone with the link could otherwise send from your numbers.
   - Optional: any other setting from `.env.example` (e.g. `RESCHEDULE_DELAY_MIN`).
4. Service → **Settings → Networking → Generate Domain**. Open that link and sign in with any username and your password.
5. Connect your WhatsApp numbers again by scanning the QR (logins from your PC don't carry over).

Keep the service at **1 replica**: two copies would each send every message. `railway.json` sets the start command and health check (`/healthz`). All times stay in IST whatever region Railway uses. WhatsApp is more likely to flag numbers linked from cloud servers than from a home PC, so start with a number you can afford to lose.

## Finding your way

The dashboard has four tabs across the top. Each tab has its own link, so the browser Back button works.

- **This week**: **Lined up next** lists every message that will go out automatically (no approval needed), with a Preview button and a clear warning if something would stop it sending. Below that, the week grid shows each workshop day by day. Until setup is finished, a **Getting started** checklist at the top links to each step.
- **Programmes**: the landing pages and their fact sheets. The badge shows how many are ready (e.g. `3/10`).
- **WhatsApp numbers**: connect a number by scanning its QR. The badge turns red if none is connected. **↻ Resync** reconnects with the same login (no QR) and reloads its groups and communities. Use it after joining a new community, or if a number seems stuck. It also updates renamed groups in your workshops and warns about groups the number has left. The workshop editor has the same button next to the group list.
- **Sent & activity**: every message that went out, plus the activity log. A red badge appears if any group failed.

Warnings on a workshop are buttons: **Fact sheet missing** opens that programme, **No community picked** opens the workshop at the community step. Click a workshop's name (or tab to it and press Enter) to edit, reschedule or preview it.

## First time: build the 10 fact sheets

All 10 landing pages are already listed under **Programmes** (if you delete or rename one, it stays that way). For each one, press **Build → Read landing page**, then look over the fact sheet and fix anything wrong. You do this once per programme and it's reused every week. Rebuild it only if the landing page changes.

If a page won't load (some pages fill in content with JavaScript), open it in your browser, copy all the text, and use **Paste its text** instead.

Dates and times are never taken from the landing page, because those are often old. They always come from the workshop run you set up.

## Every week: add each workshop run

1. **Connect a number** once → scan the QR from WhatsApp → Linked devices.
2. **+ New workshop** → pick the programme, date, start time (IST), bonus form link and Zoom link.
3. **Pick the sending number and the community** (e.g. search "4th Oct").
4. **Save.** That's it. Messages go out automatically every day at the hype time until the workshop.

If you save after today's hype time, today's message goes out within a minute. To start tomorrow instead, change **Start sending from**.

## Reschedules

Press **📅 Reschedule** on the workshop in **This week** (or open it and scroll to Reschedule) → enter the new date (and new time if it changed).

- The "date changed" message goes out **5 minutes after you save**, so you can still cancel a mistake.
- **Announce now** skips the wait.
- While a reschedule is waiting, that workshop's regular messages pause.
- After the announcement, the workshop moves to the new date and the daily hype continues toward it.

To change the wait, set `RESCHEDULE_DELAY_MIN=5` in `.env` (or Railway Variables).

## How it avoids made-up content

- Claude only sees the programme's fact sheet plus this run's date and time, never the open web.
- Before sending, every number, day name and month name in the message is checked against that fact sheet. After a reschedule, the old date is no longer allowed in messages.
- Links, countdown wording ("3 days left"), and messages that are too short or too long are rejected.
- A rejected draft is rewritten up to twice with the reason. If it still fails, a fixed template built from the fact sheet goes out instead (marked "safe template" in the dashboard).
- Form and Zoom links are inserted by code, never written by AI.
- Each programme has its own **signature** (e.g. `*Team Akshat Dani*` + `akshatdani.com`), added by code as the last lines of every message. Edit it under **Programmes → View**.
- Everyone in these communities has **already joined** (paid). Messages never mention price or payment and never ask people to register or buy; their only job is to get people to **show up live**. Price facts are removed from what Claude sees, and a draft that mentions money or "register / sign up / buy" is rejected.
- Messages are short punchy lines (no paragraph over ~20 words), written to build hype and FOMO so people show up live: a hook opening, what they'd miss, and a push to block the time. Scarcity ("limited seats", "no replay", deadlines) is only used if the landing page says it.
- Messages aim for 70–110 words with 3–5 emojis, in short paragraphs. The workshop name, the date and time, and the biggest benefit are in *bold*, and the links sit under bold labels (🎁 *Unlock your surprise bonus:*, 🎥 *Zoom link:*). A draft that's too short or has no emojis is sent back to Claude to rewrite.

## Good to know

- One message per workshop per day. The same text goes to every group picked for it, 4–7 seconds apart.
- If the PC was off at send time, the message goes out as soon as it's back on the same day. A day-of message is skipped if the workshop has already started.
- If the WhatsApp number is disconnected at send time (e.g. during a Railway redeploy), the message waits and goes out as soon as it reconnects. **Lined up next** shows "WhatsApp number not connected" while it waits.
- Groups that fail are retried every 5 minutes for about an hour. If one still fails after that, the Activity log says so in red, so you know to send it manually.
- All data lives in the `data` folder, including WhatsApp logins. Don't share it.
- The dashboard only opens on this PC by default. To use it from your phone or another computer on the same network, set `HOST=0.0.0.0` **and** `DASHBOARD_PASSWORD` in `.env`.
- Tests: `npm test` (logic, a full-week scheduler run, safety checks, and delivery retries). The scheduler test runs a full week with a reschedule, using a fake Claude and no real WhatsApp.
- Unofficial WhatsApp automation can get a number restricted, so use numbers you're prepared for that on.
