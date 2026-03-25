import { startServer } from './server.js';

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`) || args.includes(`-${name[0]}`);
}

function flagValue(name: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` || (short && args[i] === `-${short}`)) {
      return args[i + 1];
    }
    if (args[i].startsWith(`--${name}=`)) {
      return args[i].split('=').slice(1).join('=');
    }
  }
  return undefined;
}

if (flag('help') || flag('h')) {
  console.log(`
Workflow Studio - Node-based AI workflow composition

Usage:
  workflow-studio [options]

Options:
  --port, -p <number>   HTTP port (default: 4317)
  --host <string>       Host to bind (default: 127.0.0.1)
  --run                 Run a workflow graph once (headless)
  --graph, -g <path>    Path to workflow graph JSON (with --run)
  --vars <json>         JSON string of variables (with --run)
  --debug, -d           Enable verbose execution logging
  --help, -h            Show this help message

Examples:
  workflow-studio                        Launch the browser UI
  workflow-studio --run -g plan.json     Run a graph headlessly
`);
  process.exit(0);
}

startServer({
  port: flagValue('port', 'p') ? Number(flagValue('port', 'p')) : undefined,
  host: flagValue('host') || undefined,
  run: flag('run'),
  graph: flagValue('graph', 'g'),
  vars: flagValue('vars'),
  debug: flag('debug'),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
