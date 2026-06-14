export const capitalOneProfiles = [
  {
    name: 'Capital One',
    headerFingerprint: ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'],
    dateColumns: ['Transaction Date'],
    dateFormats: ['yyyy-MM-dd'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: 'Category',
  },
];
