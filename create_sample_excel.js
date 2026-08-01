const XLSX = require('xlsx');
const path = require('path');

const sampleData = [
    { Name: "Rahul Sharma", Phone: "9876543210", App_Link: "https://myapp.com/download", Offer: "50% OFF" },
    { Name: "Priya Patel", Phone: "9123456789", App_Link: "https://myapp.com/download", Offer: "Free VIP Pass" },
    { Name: "Amit Verma", Phone: "9988776655", App_Link: "https://myapp.com/download", Offer: "100 Bonus Coins" },
    { Name: "Neha Gupta", Phone: "9811223344", App_Link: "https://myapp.com/download", Offer: "Special Discount" },
    { Name: "Vikas Singh", Phone: "9711002233", App_Link: "https://myapp.com/download", Offer: "Early Access" }
];

const worksheet = XLSX.utils.json_to_sheet(sampleData);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, "MarketingContacts");

const outputPath = path.join(__dirname, 'sample_contacts.xlsx');
XLSX.writeFile(workbook, outputPath);
console.log("✅ Created sample Excel file at:", outputPath);
