import { americanExpressProfiles } from './profiles/americanExpress';
import { appleCardProfiles } from './profiles/appleCard';
import { bankOfAmericaProfiles } from './profiles/bankOfAmerica';
import { capitalOneProfiles } from './profiles/capitalOne';
import { chaseProfiles } from './profiles/chase';
import { citiProfiles } from './profiles/citi';
import { robinhoodProfiles } from './profiles/robinhood';
import { wellsFargoProfiles } from './profiles/wellsFargo';

export const BANK_PROFILES = [
  ...chaseProfiles,
  ...wellsFargoProfiles,
  ...bankOfAmericaProfiles,
  ...robinhoodProfiles,
  ...americanExpressProfiles,
  ...appleCardProfiles,
  ...capitalOneProfiles,
  ...citiProfiles,
];

export const SUPPORTED_BANK_NAMES = [
  'Chase',
  'Bank of America',
  'Wells Fargo',
  'Wells Fargo Credit Card',
  'Robinhood Credit Card',
  'American Express',
  'Apple Card',
  'Capital One',
  'Citi',
];
