export const robinhoodProfiles = [
  {
    name: 'Robinhood Credit Card',
    headerFingerprint: ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description'],
    statementType: 'credit_card',
    dateColumns: ['Date'],
    dateFormats: ['yyyy-MM-dd'],
    descriptionColumn: 'Description',
    merchantColumn: 'Merchant',
    amountConfig: { type: 'single', column: 'Amount', positiveIsCharge: true },
    categoryColumn: null,
  },
];
