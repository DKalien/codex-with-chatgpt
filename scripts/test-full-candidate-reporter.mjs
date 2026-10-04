import fs from 'node:fs';
import path from 'node:path';

export default class CandidateReporter {
  onTestRunEnd(modules, errors, reason) {
    const files = modules.map(module => ({
      file: path.relative(process.cwd(), module.moduleId).replaceAll('\\', '/'),
      state: module.state(),
      diagnostic: module.diagnostic(),
      tests: Array.from(module.children.allTests(), test => ({
        name: test.fullName, state: test.result().state, diagnostic: test.diagnostic(),
      })),
    }));
    fs.writeFileSync(process.env.C2C_CANDIDATE_REPORT, JSON.stringify({ reason, errors: errors.length, files }, null, 2));
  }
}
