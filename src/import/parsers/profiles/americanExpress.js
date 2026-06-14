export const americanExpressProfiles = [
  {
    name: 'American Express Credit Card',
    headerFingerprint: ['Date', 'Description', 'Amount'],
    fileNamePatterns: ['amex', 'american express'],
    requireFileNameMatch: true,
    statementType: 'credit_card',
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', positiveIsCharge: true },
    categoryColumn: null,
  },
];
