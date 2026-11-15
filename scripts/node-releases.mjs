const scheduleUrl = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';

export function supportedMajors(schedule, today = new Date().toISOString().slice(0, 10)) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) throw new Error('Invalid Node release schedule');
  const majors = Object.entries(schedule)
    .filter(([name, release]) => /^v\d+$/.test(name) && release?.start <= today && release?.end > today)
    .map(([name]) => Number(name.slice(1))).sort((a, b) => a - b);
  if (!majors.length) throw new Error('Node release schedule contains no supported branches');
  return new Set(majors);
}

export async function loadSupportedMajors() {
  const response = await fetch(scheduleUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Node release schedule: HTTP ${response.status}`);
  return supportedMajors(await response.json());
}
