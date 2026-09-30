# Hype Dispatch

Auto-sends daily messages to your workshop WhatsApp communities, written by Claude **only from each workshop's landing page**.

| When | What goes out | Links |
|---|---|---|
| 2+ days before | Hype message (new angle each day, never a countdown) | none |
| 1 day before | "Dropping tomorrow" | Form + Zoom |
| Workshop day | "We're live today" (can be switched off per workshop) | Zoom |
| Rescheduled | New date announcement, at the 7 PM check | none |

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

## First time: build the 10 fact sheets

All 10 landing pages are already listed under **Programmes** (if you delete or rename one, it stays that way). For each one, press **Build → Read landing page**, then look over the fact sheet and fix anything wrong. You do this once per programme and it's reused every week. Rebuild it only if the landing page changes.

If a page won't load (some pages fill in content with JavaScript), open it in your browser, copy all the text, and use **Paste its text** instead.

Dates and times are never taken from the landing page, because those are often old. They always come from the workshop run you set up.

## Every week: add each workshop run

1. **Connect a number** once → scan the QR from WhatsApp → Linked devices.
2. **+ New workshop** → pick the programme, date, start time (IST), form link and Zoom link.
3. **Pick the sending number and the community** (e.g. search "4th Oct").
4. **Save.** That's it. Messages go out automatically every day at the hype time until the workshop.

If you save after today's hype time, today's message goes out within a minute. To start tomorrow instead, change **Start sending from**.

## Reschedules

Open the workshop → **Reschedule** → enter the new date (and new time if it changed).

- It's announced at **7 PM IST**, the daily check, so you can still cancel until then.
- If you enter it after 7 PM, it goes out right away.
- **Announce now** skips the wait.
- While a reschedule is pending, the regular messages for that workshop pause.
- After the announcement, the workshop moves to the new date and the daily hype continues toward it.

To change the check time, set `RESCHEDULE_CHECK_TIME=19:00` in `.env`.

## How it avoids made-up content

- Claude only sees the programme's fact sheet plus this run's date and time, never the open web.
- Before sending, every number, day name and month name in the message is checked against that fact sheet. After a reschedule, the old date is no longer allowed in messages.
- Links, countdown wording ("3 days left"), and messages that are too short or too long are rejected.
- A rejected draft is rewritten up to twice with the reason. If it still fails, a fixed template built from the fact sheet goes out instead (marked "safe template" in the dashboard).
- Form and Zoom links are inserted by code, never written by AI.

## Good to know

- One message per workshop per day. The same text goes to every group picked for it, 4–7 seconds apart.
- If the PC was off at send time, the message goes out as soon as it's back on the same day. A day-of message is skipped if the workshop has already started.
- Failed groups are retried automatically, up to 3 rounds.
- All data lives in the `data` folder, including WhatsApp logins. Don't share it.
- The dashboard only opens on this PC by default. To use it from your phone or another computer on the same network, set `HOST=0.0.0.0` **and** `DASHBOARD_PASSWORD` in `.env`.
- Tests: `npm test` (logic, a full-week scheduler run, and safety checks). The scheduler test runs a full week with a reschedule, using a fake Claude and no real WhatsApp.
- Unofficial WhatsApp automation can get a number restricted, so use numbers you're prepared for that on.
