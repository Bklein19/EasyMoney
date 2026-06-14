export const citiProfiles = [
  {
    name: 'Citi',
    headerFingerprint: ['Status', 'Date', 'Description', 'Debit', 'Credit'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: null,
  },
];
