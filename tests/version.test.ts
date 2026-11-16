// Settings › Check for updates: comparing release tags with the app's version.
import { compareVersions } from '../web/src/version.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
check('newer patch', compareVersions('v0.1.5', '0.1.4') > 0, true);
check('same', compareVersions('v0.1.4', '0.1.4'), 0);
check('older', compareVersions('0.1.3', '0.1.4') < 0, true);
check('0.10 after 0.9', compareVersions('0.10.0', '0.9.9') > 0, true);
if (fail) { console.log(`${fail} failed`); process.exit(1); }
