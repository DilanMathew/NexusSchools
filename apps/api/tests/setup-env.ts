process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://attendiq:attendiq@localhost:5432/attendiq_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-test-access-secret-0000';
process.env.QR_TOKEN_SECRET ??= 'test-qr-secret-test-qr-secret-test-qr-0000';
