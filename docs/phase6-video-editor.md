# BUILD: Triangle Resells Phase 6 — AI video editor + Instagram posting

## Status: WAITLISTED
Do not start until BOTH are true:
1. The AI DM bot is live (crm-v1 merged into the deploy branch, Sonnet retest passed, BOT_ENABLED=true).
2. The CRM v1 is live (Supabase + Netlify running, phases 1-5 done incl. the video ideas calendar, end-to-end tests passed).
If either isn't done, tell Josh what's left instead of starting.

## Who I am
Josh, owner of Triangle Resells (Wendell/Raleigh NC resale: streetwear, cologne, bulk). Team: Josh, Chema, Diego (full access).
I post mostly on Instagram (Triangle Resells, Triangle Scales, Triangle Sales). The CRM already has a daily video ideas
calendar per account (goals: Resells 3, Scales 2, Sales 6 incl. a meetup video) with To film -> Filmed -> Posted.

## What I want
A bot that fully edits my videos from the raw clips I send it, to my style, and posts them to Instagram after I approve.
Flow:
1. In the CRM, on a video idea for that day, I upload the raw clips (from my phone).
2. The bot transcribes the audio (speech-to-text service), pulls frames from the clips, and Claude plans the edit:
   best takes, cut dead air / mistakes / filler, strongest hook in the first 2 seconds, pacing, on-screen text, captions.
3. It renders the video (FFmpeg on the server): 9:16 vertical, burned-in captions, text overlays, zoom/punch-in cuts,
   royalty-free background music if the style calls for it, cover frame, MP4 ready for Reels.
4. It writes the Instagram caption + hashtags for the right account.
5. The CRM shows me a preview with: Approve / Redo (with my note, e.g. "shorter hook", "less text") / Reject.
6. Approve -> it posts the Reel to the right Instagram account, saves the post link, marks the idea Posted.
7. My Redo notes and approvals update a style guide so it learns my taste over time.

---
Note: the spec as received started mid-sentence ("...(e.g. docs/phase6-video-editor.md) and to my memory as
'waitlisted until the bot and CRM are live'"). Anything before that line, and anything after step 7, wasn't included.
