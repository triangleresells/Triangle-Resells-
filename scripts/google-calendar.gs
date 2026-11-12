/**
 * Triangle Resells: paid orders -> Google Calendar.
 * Paste this into a Google Apps Script project owned by the Google account whose calendar you check
 * (script.google.com -> New project), then Deploy -> New deployment -> Web app,
 * Execute as: Me, Who has access: Anyone. Copy the web app URL into CALENDAR_WEBHOOK_URL on Render.
 *
 * Taken pickup times: the bot also READS this calendar (doGet below) and never offers a time that
 * overlaps an event. To block a time, just add an event to this calendar. To close a whole day,
 * add an all-day event with "closed" in the title. Other all-day events don't block anything.
 * After pasting a new version: Deploy -> Manage deployments -> edit -> Version: New version (the URL stays the same).
 *
 * POST actions (JSON body):
 *   (no action) or "create": {title, date, time, durationMinutes, location, description} -> {ok, id}
 *   "move":   {id, date, time, durationMinutes} -> moves that event (a reschedule)
 *   "delete": {id} -> deletes it (a cancel), which also frees the time for other buyers
 */
function doGet(e) {
  var days = Math.min(Number((e && e.parameter && e.parameter.busy) || 14), 31);
  var start = new Date();
  start.setHours(0, 0, 0, 0);
  var end = new Date(start.getTime() + days * 86400000);
  var busy = CalendarApp.getDefaultCalendar().getEvents(start, end).map(function (ev) {
    return {
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      allDay: ev.isAllDayEvent(),
      // Timed titles stay private, except bot deliveries ("🚗 DELIVERY 35min"), so routes go farthest first.
      title: ev.isAllDayEvent() || /DELIVERY\s+\d+\s*min/i.test(ev.getTitle()) ? ev.getTitle() : '',
    };
  });
  return ContentService.createTextOutput(JSON.stringify({ busy: busy })).setMimeType(ContentService.MimeType.JSON);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// "2026-11-14" + "3:00 PM" -> start Date, or null for an all-day event / a bad date.
function startOf(date, time) {
  var p = (date || '').split('-');
  if (p.length !== 3) return { bad: true };
  var day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var t = (time || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!t) return { day: day, start: null };
  var h = Number(t[1]) % 12 + (/pm/i.test(t[3] || '') ? 12 : 0);
  if (!t[3] && Number(t[1]) < 10) h += 12; // "3" with no am/pm means 3 PM (pickups are 10 AM to 10 PM)
  return { day: day, start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, Number(t[2] || 0)) };
}

function doPost(e) {
  var ev = JSON.parse(e.postData.contents);
  var cal = CalendarApp.getDefaultCalendar();
  var action = ev.action || 'create';

  if (action === 'move' || action === 'delete') {
    var found = ev.id ? cal.getEventById(ev.id) : null;
    if (!found) return reply({ ok: false, error: 'event not found' });
    if (action === 'delete') {
      found.deleteEvent();
      return reply({ ok: true });
    }
    var when = startOf(ev.date, ev.time);
    if (when.bad) return reply({ ok: false, error: 'bad date' });
    if (when.start) found.setTime(when.start, new Date(when.start.getTime() + (ev.durationMinutes || 30) * 60000));
    else found.setAllDayDate(when.day);
    return reply({ ok: true, id: found.getId() });
  }

  var w = startOf(ev.date, ev.time);
  if (w.bad) return reply({ ok: false, error: 'bad date' });
  var opts = { location: ev.location || '', description: ev.description || '' };
  var event;
  if (w.start) {
    event = cal.createEvent(ev.title, w.start, new Date(w.start.getTime() + (ev.durationMinutes || 30) * 60000), opts);
    event.addPopupReminder(60);
  } else {
    event = cal.createAllDayEvent(ev.title, w.day, opts);
    event.addPopupReminder(9 * 60); // morning of the ship day
  }
  return reply({ ok: true, id: event.getId() });
}
