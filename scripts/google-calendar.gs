/**
 * Triangle Resells: paid orders -> Google Calendar.
 * Paste this into a Google Apps Script project owned by the Google account whose calendar you check
 * (script.google.com -> New project), then Deploy -> New deployment -> Web app,
 * Execute as: Me, Who has access: Anyone. Copy the web app URL into CALENDAR_WEBHOOK_URL on Render.
 *
 * Taken pickup times: the bot also READS this calendar (doGet below) and never offers a time that
 * overlaps an event. To block a time, just add an event to this calendar. To close a whole day,
 * add an all-day event with "closed" in the title. Other all-day events don't block anything.
 * After pasting a new version: Deploy -> Manage deployments -> edit -> Version: New version.
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

function doPost(e) {
  var ev = JSON.parse(e.postData.contents);
  var cal = CalendarApp.getDefaultCalendar();
  var opts = { location: ev.location || '', description: ev.description || '' };
  var p = (ev.date || '').split('-');
  if (p.length !== 3) return ContentService.createTextOutput('bad date');
  var day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var t = (ev.time || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  var event;
  if (t) {
    var h = Number(t[1]) % 12 + (/pm/i.test(t[3] || '') ? 12 : 0);
    if (!t[3] && Number(t[1]) < 10) h += 12; // "3" with no am/pm means 3 PM (pickups are 10 AM to 10 PM)
    var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, Number(t[2] || 0));
    var end = new Date(start.getTime() + (ev.durationMinutes || 30) * 60000);
    event = cal.createEvent(ev.title, start, end, opts);
    event.addPopupReminder(60);
  } else {
    event = cal.createAllDayEvent(ev.title, day, opts);
    event.addPopupReminder(9 * 60); // morning of the ship day
  }
  return ContentService.createTextOutput('ok');
}
