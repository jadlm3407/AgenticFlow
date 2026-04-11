/**
 * AgenticFlow — BRC-100 Wallet Generator
 * Generates three independent BSV wallets for the agent network.
 *
 * Usage:  npm run generate-wallets
 */

import { PrivateKey } from "@bsv/sdk";

function generateWallet(name: string) {
  const key     = PrivateKey.fromRandom();
  const wif     = key.toWif();
  const address = key.toAddress().toString();
  return { name, wif, address };
}

const wallets = [
  generateWallet("SkillsAgent"),
  generateWallet("ClientAgent"),
  generateWallet("EngineAgent"),
];

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║   AgenticFlow — BRC-100 Wallet Generator            ║");
console.log("║   ⚠️  Save these somewhere safe — shown only once!  ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

wallets.forEach(w => {
  console.log(`── ${w.name} ${"─".repeat(44 - w.name.length)}`);
  console.log(`  Address : ${w.address}`);
  console.log(`  WIF     : ${w.wif}\n`);
});

const [skills, client, engine] = wallets;

console.log("── Paste into .env ─────────────────────────────────────\n");
console.log(`SKILLS_AGENT_WIF=${skills.wif}`);
console.log(`SKILLS_AGENT_ADDRESS=${skills.address}`);
console.log(`CLIENT_AGENT_WIF=${client.wif}`);
console.log(`CLIENT_AGENT_ADDRESS=${client.address}`);
console.log(`ENGINE_AGENT_WIF=${engine.wif}`);
console.log(`ENGINE_AGENT_ADDRESS=${engine.address}`);

console.log("\n── Funding required ────────────────────────────────────");
console.log(`  EngineAgent  → send ≥ 60,000 sats to ${engine.address}`);
console.log(`  ClientAgent  → send ≥ 10,000 sats to ${client.address}`);
console.log(`  SkillsAgent  → no initial funding needed (receives payments)\n`);
