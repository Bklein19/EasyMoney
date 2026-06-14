export const chaseProfiles = [
  {
    name: 'Chase Credit Card',
    headerFingerprint: ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'],
    statementType: 'credit_card',
    dateColumns: ['Transaction Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', positiveIsCharge: false },
    categoryColumn: 'Category',
  },
];
