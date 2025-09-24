import step1 from "./scripts/steps/step1.ts";
import step2 from "./scripts/steps/step2.ts";
import step3 from "./scripts/steps/step3.ts";
import step4 from "./scripts/steps/step4.ts";
import step5 from "./scripts/steps/step5.ts";

import dotenv from 'dotenv';
import step6 from "./scripts/steps/step6.ts";
dotenv.config();

async function main() {
  // The step argument (e.g., "step1", "step2", etc.) 
  // is passed after the '--' in the CLI command 
  // e.g. npm run deploy -- step1
  const stepArg = process.argv[2];

  if (!stepArg) {
    console.log('No step provided. Usage: npm run deploy -- step1');
    process.exit(1);
  }

  console.log(`Running deployment step: ${stepArg}`);

  try {
    switch (stepArg) {
      case 'step1':
        await step1();
        break;
      case 'step2':
        await step2();
        break;
      case 'step3':
        await step3();
        break;
      case 'step4':
        await step4();
        break;
      case 'step5':
        await step5();
        break
      case 'step6':
        await step6();
        break;
      default:
        console.log(`Unknown step: ${stepArg}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error running deployment step:', error);
    process.exit(1);
  }
}

main();
