import os

from actual.queries import get_transactions

from actual import Actual

with Actual(
        base_url="http://localhost:5007",  # Url of the Actual Server
        password=os.environ.get("ACTUAL_PASSWORD"),  # Password for authentication
        #encryption_password=None,  # Optional: Password for the file encryption. Will not use it if set to None.
        # Set the file to work with. Can be either the file id or file name, if name is unique
        # Needs to be a cloud file, see  https://actualbudget.org/docs/getting-started/sync/#this-file-is-not-a-cloud-file',
        file=os.environ.get("ACTUAL_BUDGET_SYNC_ID"),
        # Optional: Directory to store downloaded files. Will use a temporary if not provided
        data_dir="/tmp/actual",
        # Optional: Path to the certificate file to use for the connection, can also be set as False to disable SSL verification
        #cert="<path_to_cert_file>"
) as actual:
    transactions = get_transactions(actual.session)
    for t in transactions:
        account_name = t.account.name if t.account else None
        category = t.category.name if t.category else None
        print(t.date, account_name, t.notes, t.amount, category)
