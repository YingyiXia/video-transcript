function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const remainingSeconds = Math.floor(milliseconds / 1000) % 60;
  const remainingMilliseconds = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')},${String(remainingMilliseconds).padStart(3, '0')}`;
}

export function toSrt(segments, duration) {
  return segments.map((segment, index) => {
    const start = Math.max(0, Number(segment.start) || 0);
    const nextStart = Number(segments[index + 1]?.start);
    let end = Number(segment.end);
    if (!Number.isFinite(end) || end <= start) end = Number.isFinite(nextStart) && nextStart > start ? nextStart : start + 2;
    if (Number.isFinite(duration) && duration > start) end = Math.min(end, duration);
    end = Math.max(end, start + 0.001);
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${segment.text.trim()}\n`;
  }).join('\n');
}
