export const appleCardProfiles = [
  {
    name: 'Apple Card',
    headerFingerprint: ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'],
    statementType: 'credit_card',
    dateColumns: ['Transaction Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Merchant',
    amountConfig: { type: 'single', column: 'Amount (USD)', positiveIsCharge: true },
    categoryColumn: 'Category',
  },
];
