import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

export async function hash_password(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verify_password(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
}
