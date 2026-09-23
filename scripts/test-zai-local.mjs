// Quick local test for z-ai-web-dev-sdk — verifies your .z-ai-config works.
// Usage:  node scripts/test-zai-local.mjs
import ZAI from 'z-ai-web-dev-sdk';

async function main() {
  const zai = await ZAI.create();
  const res = await zai.chat.completions.create({
    messages: [
      { role: 'user', content: 'Say "config works" and nothing else.' },
    ],
  });
  console.log('✅ SDK OK →', res.choices[0]?.message?.content);
}

main().catch((e) => {
  console.error('❌ SDK failed:', e.message);
  process.exit(1);
});
