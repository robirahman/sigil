/**
 * vacation-bank.js — the correspondence vacation bank: 14 days a calendar
 * year (UTC), each day of a vacation charged to the year it begins in.
 *
 * One copy for the site and the server: account.html loads it as a classic
 * script for the days picker, and functions/vacation.js require()s it for
 * setVacation, so the picker offers exactly what the server accepts.
 */

var VACATION_DAY_MS = 24 * 60 * 60 * 1000;
var VACATION_DAYS_PER_YEAR = 14;

function vacationYearOf(ms) { return new Date(ms).getUTCFullYear(); }

/** The calendar year (UTC) of each day of a vacation from `from`: day i begins at from + i days. */
function vacationDayYears(from, days) {
	return Array.from({ length: days }, (_, i) => vacationYearOf(from + i * VACATION_DAY_MS));
}

/** Days used per year, { [year]: n }, for the stored record `v` (may be null). */
function vacationUsedByYear(v) {
	if (!v) return {};
	if (v.used && typeof v.used === 'object') return Object.assign({}, v.used);
	// The first form of the record: one year's count.
	return typeof v.year === 'number' ? { [v.year]: v.usedDays || 0 } : {};
}

/** Days left in `year`'s bank (that of `now` by default) for the record `v`. */
function vacationDaysLeft(v, now, year) {
	const y = year === undefined ? vacationYearOf(now) : year;
	return Math.max(0, VACATION_DAYS_PER_YEAR - (vacationUsedByYear(v)[y] || 0));
}

/**
 * The bank after charging a `days`-day vacation from `now` to record `v`:
 * { used } (past years dropped), or null when a year it touches is short.
 */
function vacationCharge(v, days, now) {
	const used = {};
	const all = vacationUsedByYear(v);
	for (const y of Object.keys(all)) if (Number(y) >= vacationYearOf(now)) used[y] = all[y];
	for (const y of vacationDayYears(now, days)) used[y] = (used[y] || 0) + 1;
	return Object.keys(used).some((y) => used[y] > VACATION_DAYS_PER_YEAR) ? null : { used };
}

/** The longest vacation record `v` allows starting at `now` (0 when none). */
function vacationMaxDays(v, now) {
	let n = 0;
	while (n < VACATION_DAYS_PER_YEAR && vacationCharge(v, n + 1, now)) n++;
	return n;
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { VACATION_DAY_MS, VACATION_DAYS_PER_YEAR, vacationYearOf, vacationDayYears, vacationUsedByYear,
		vacationDaysLeft, vacationCharge, vacationMaxDays };
}
