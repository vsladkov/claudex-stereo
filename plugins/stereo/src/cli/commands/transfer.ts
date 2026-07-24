import { executeTransfer } from "../../workflows/transfer.ts";
import { outputCommandResult, parseCommandInput, resolveCommandCwd } from "../io.ts";

export async function handleTransfer(argv: string[]): Promise<void> {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source as string | undefined
  });
  outputCommandResult(payload, rendered, options.json);
}
