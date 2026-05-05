type TestCase = {
  name: string
  run: () => Promise<void> | void
}

const tests: TestCase[] = []

export function test(name: string, run: TestCase["run"]): void {
  tests.push({ name, run })
}

export async function runTests(): Promise<void> {
  await tests.reduce(async (previousTest, testCase) => {
    await previousTest

    try {
      await testCase.run()
      // eslint-disable-next-line no-console
      console.log(`ok - ${testCase.name}`)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`not ok - ${testCase.name}`)
      throw error
    }
  }, Promise.resolve())
}
