let api = require('@actual-app/api');
const actualPassword = process.env.ACTUAL_PASSWORD;

(async () => {
  await api.init({
    // Budget data will be cached locally here, in subdirectories for each file.
    dataDir: '/tmp/actual',
    // This is the URL of your running server, started from the CLI or the Desktop app
    serverURL: 'http://localhost:5007',
    // This is the password you use to log into the server
    password: actualPassword,
  });

  const budgets = await api.getBudgets();
  console.log('Budgets:', budgets);
  if (!budgets.length) {
    console.log(
      'No budgets found. You need to create cloud files first: https://actualbudget.org/docs/getting-started/sync/#this-file-is-not-a-cloud-file',
    );
    await api.shutdown();
    return;
  }

  const firstBudget = budgets[0];
  console.log(`Downloading budget: ${firstBudget.name || '(unnamed)'}`);
  await api.downloadBudget(firstBudget.groupId);

  const accounts = await api.getAccounts();
  console.log('Accounts:', accounts);

  await api.shutdown();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
