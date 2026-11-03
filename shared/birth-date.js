/* Birth date helpers for Edit profile (X's Month / Day / Year pickers).
   Dates are plain calendar days, never instants: "1990-03-01" is shown and
   saved as that day in every time zone, so nothing slips by a day. A
   classic script: the page reads window.ViktorychBirthDate, and Node tests
   import the file and read globalThis.ViktorychBirthDate. */
(function (root) {
  var MIN_AGE = 13;
  var FIRST_YEAR = 1900;
  function pad(n) { return String(n).padStart(2, "0"); }
  function leap(year) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
  /* Days in a month; with no year February keeps the 29th. */
  function daysIn(month, year) {
    month = Number(month) || 0;
    if (month < 1 || month > 12) return 31;
    if (month === 2) return !year || leap(Number(year)) ? 29 : 28;
    return [4, 6, 9, 11].indexOf(month) >= 0 ? 30 : 31;
  }
  function valid(year, month, day) {
    year = Number(year) || 0;
    month = Number(month) || 0;
    day = Number(day) || 0;
    if (month < 1 || month > 12 || day < 1) return false;
    if (year && (year < FIRST_YEAR || year > 9999)) return false;
    return day <= daysIn(month, year);
  }
  /* "1990-03-01" or "03-01" (no year). Anything else is free text from the
     About page and is left alone. */
  function parse(text) {
    var raw = String(text == null ? "" : text).trim();
    var full = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    var short = raw.match(/^(\d{1,2})-(\d{1,2})$/);
    var parts = full ? { year: +full[1], month: +full[2], day: +full[3] } : short ? { year: 0, month: +short[1], day: +short[2] } : null;
    return parts && valid(parts.year, parts.month, parts.day) ? parts : null;
  }
  function compose(year, month, day) {
    if (!valid(year, month, day)) return "";
    return (Number(year) ? String(Number(year)) + "-" : "") + pad(Number(month)) + "-" + pad(Number(day));
  }
  /* Today's calendar day on this device (its own zone), as numbers. */
  function today(now) {
    var date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  /* Whole years old on a calendar day; a 29 February birthday counts from
     1 March in other years. */
  function age(parts, on) {
    if (!parts || !parts.year || !on) return null;
    var years = on.year - parts.year;
    var month = parts.month;
    var day = parts.day;
    if (month === 2 && day === 29 && !leap(on.year)) { month = 3; day = 1; }
    if (on.month < month || (on.month === month && on.day < day)) years -= 1;
    return years;
  }
  function inFuture(parts, on) {
    if (!parts || !parts.year || !on) return false;
    if (parts.year !== on.year) return parts.year > on.year;
    if (parts.month !== on.month) return parts.month > on.month;
    return parts.day > on.day;
  }
  /* "" when the date can be saved, else a reason: "incomplete", "invalid",
     "future" or "young" (under the minimum age). */
  function check(year, month, day, on, minAge) {
    year = Number(year) || 0;
    month = Number(month) || 0;
    day = Number(day) || 0;
    if (!year && !month && !day) return "";
    if (!year || !month || !day) return "incomplete";
    if (!valid(year, month, day)) return "invalid";
    var parts = { year: year, month: month, day: day };
    var when = on || today();
    if (inFuture(parts, when)) return "future";
    var old = age(parts, when);
    if (old != null && old < (minAge == null ? MIN_AGE : minAge)) return "young";
    return "";
  }
  function years(on) {
    var top = (on || today()).year;
    var list = [];
    for (var y = top; y >= FIRST_YEAR; y -= 1) list.push(y);
    return list;
  }
  function monthNames(lang) {
    var names = [];
    for (var m = 1; m <= 12; m += 1) {
      var text = "";
      try { text = new Intl.DateTimeFormat(lang || "en", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, m - 1, 1))); } catch (err) { text = ""; }
      names.push(text ? text.charAt(0).toLocaleUpperCase(lang || "en") + text.slice(1) : String(m));
    }
    return names;
  }
  /* The saved day in the UI language, read in UTC so it never moves. */
  function label(text, lang) {
    var parts = parse(text);
    if (!parts) return String(text == null ? "" : text).trim();
    try {
      var opts = parts.year ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" } : { month: "long", day: "numeric", timeZone: "UTC" };
      return new Intl.DateTimeFormat(lang || "en", opts).format(new Date(Date.UTC(parts.year || 2000, parts.month - 1, parts.day)));
    } catch (err) {
      return compose(parts.year, parts.month, parts.day);
    }
  }
  root.ViktorychBirthDate = {
    MIN_AGE: MIN_AGE,
    FIRST_YEAR: FIRST_YEAR,
    daysIn: daysIn,
    valid: valid,
    parse: parse,
    compose: compose,
    today: today,
    age: age,
    check: check,
    years: years,
    monthNames: monthNames,
    label: label
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
