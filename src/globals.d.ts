// React Native includes btoa/atob as runtime globals but they are not part of
// the ES lib types. Declare them here so TypeScript is aware.
declare function btoa(data: string): string;
declare function atob(encodedData: string): string;
