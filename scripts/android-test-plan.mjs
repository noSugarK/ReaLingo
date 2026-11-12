import { pathToFileURL } from 'node:url';

// Keep the workflow present on every push so required checks and release gates resolve.
export function androidTestPlan(files, { event, full = false } = {}) {
  const run = event === 'workflow_dispatch' || files.some(file => !file.endsWith('.md'));
  return {
    run,
    targets: full ? ['x86_64', 'aarch64'] : ['x86_64'],
    devices: event === 'pull_request' && !full
      ? [{ api: 35, tag: 'google_apis', 'page-size': 4096 }]
      : [{ api: 35, tag: 'google_apis', 'page-size': 4096 },
        { api: 36, tag: 'google_apis_ps16k', 'page-size': 16384 }],
  };
}

export function androidReleaseReady(jobs) {
  return ['launch (35, google_apis, 4096)', 'launch (36, google_apis_ps16k, 16384)']
    .every(name => jobs.some(job => job.name === name && job.conclusion === 'success'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (process.argv.includes('--release-ready')) {
    process.exitCode = androidReleaseReady(JSON.parse(input).jobs) ? 0 : 1;
  } else {
    const plan = androidTestPlan(input.split('\0').filter(Boolean), {
      event: process.env.GITHUB_EVENT_NAME,
      full: process.env.ANDROID_TEST_FULL === 'true',
    });
    console.log(`run=${plan.run}`);
    console.log(`targets=${JSON.stringify(plan.targets)}`);
    console.log(`devices=${JSON.stringify({ include: plan.devices })}`);
  }
}
