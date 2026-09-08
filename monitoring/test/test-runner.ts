type TestCase = {
  name: string
  run: () => Promise<void> | void
}

const tests: TestCase[] = []

export function test(name: string, run: TestCase["run"]): void {
  tests.push({ name, run })
}

export async function runTests(): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax
  for (const testCase of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await testCase.run()
      // eslint-disable-next-line no-console
      console.log(`ok - ${testCase.name}`)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`not ok - ${testCase.name}`)
      throw error
    }
  }
}
