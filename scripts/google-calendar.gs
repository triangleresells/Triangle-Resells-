/**
 * Triangle Resells: paid orders -> Google Calendar.
 * Paste this into a Google Apps Script project owned by the Google account whose calendar you check
 * (script.google.com -> New project), then Deploy -> New deployment -> Web app,
 * Execute as: Me, Who has access: Anyone. Copy the web app URL into CALENDAR_WEBHOOK_URL on Render.
 */
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
    if (!t[3] && Number(t[1]) < 8) h += 12; // "3" with no am/pm means 3 PM
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
