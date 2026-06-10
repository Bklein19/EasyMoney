import { readFileSync } from 'fs';
import * as pdfjsLib from 'pdfjs-dist';
import * as crypto from 'crypto';

function hashRow(row: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

export default async function parse(filePath: string): Promise<ParseResult> {
    const rawData = new Uint8Array(readFileSync(filePath));
    const pdf = await pdfjsLib.getDocument(rawData).promise;
    const numPages = pdf.numPages;
    let transactions = [];

    for (let i = 0; i < numPages; i++) {
        const page = await pdf.getPage(i + 1);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');

        // TODO: Extract transaction data from pageText using regex or known format structure
        // This is a simple mock for structure
        const mockTransaction = {
            id: hashRow(pageText),
            date: '2023-01-01',  // Placeholder for extracted date
            amount_cents: 0,     // Placeholder for extracted amount
            description: 'Sample Transaction',  // Placeholder for extracted description
            account: 'Sample Account',          // Placeholder for extracted account
            institution: 'Custom Institution',  
            raw: { text: pageText }
        };

        transactions.push(mockTransaction);
    }

    return {
        transactions,
        balances: []
    };
}

// Required ParseResult type
type ParseResult = {
    transactions: Array<{
        id: string;
        date: string;
        amount_cents: number;
        description: string;
        account: string;
        institution: string;
        raw: Record<string, unknown>;
    }>;
    balances: Array<{
        date: string;
        account: string;
        institution: string;
        balance_cents: number;
    }>;
};
