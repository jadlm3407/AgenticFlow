/**
 * AgenticFlow — Wallet Generator
 * Run once to create all three agent wallets.
 * Prints WIF keys and addresses ready to paste into .env
 *
 * Usage:  npm run generate-wallets
 */

import { PrivateKey } from "@bsv/sdk";

interface Wallet { name: string; wif: string; address: string }

function generateWallet(name: string): Wallet {
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
console.log("║         AgenticFlow — Generated Wallets              ║");
console.log("║  ⚠️  Save these somewhere safe — shown only once!    ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

wallets.forEach(w => {
  console.log(`── ${w.name} ──────────────────────────────────────────`);
  console.log(`  Address : ${w.address}`);
  console.log(`  WIF     : ${w.wif}`);
  console.log("");
});

console.log("── Paste into .env ────────────────────────────────────\n");
const [skills, client, engine] = wallets;
console.log(`SKILLS_AGENT_WIF=${skills.wif}`);
console.log(`SKILLS_AGENT_ADDRESS=${skills.address}`);
console.log(`CLIENT_AGENT_WIF=${client.wif}`);
console.log(`CLIENT_AGENT_ADDRESS=${client.address}`);
console.log(`ENGINE_AGENT_WIF=${engine.wif}`);
console.log(`ENGINE_AGENT_ADDRESS=${engine.address}`);
console.log("");
console.log("── Fund these addresses before running ────────────────");
console.log(`  ClientAgent  → send ≥ 100,000 sats to ${client.address}`);
console.log(`  EngineAgent  → send ≥ 2,500,000 sats to ${engine.address}`);
console.log(`  SkillsAgent  → no initial funding needed (receives payments)\n`);
