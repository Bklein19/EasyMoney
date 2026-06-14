export const bankOfAmericaProfiles = [
  {
    name: 'Bank of America',
    headerFingerprint: ['Date', 'Description', 'Amount', 'Running Bal.'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', negativeIsDebit: true },
    categoryColumn: null,
  },
];
