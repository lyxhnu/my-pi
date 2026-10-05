import { RootSessionOwnership } from "../../src/core/subagents/session-ownership.ts";

try {
	const owner = RootSessionOwnership.acquire(process.argv[2], process.argv[3]);
	process.stdout.write("owned\n");
	process.stdin.resume();
	process.stdin.on("end", () => {
		owner.close();
		process.exit(0);
	});
} catch (error) {
	process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
