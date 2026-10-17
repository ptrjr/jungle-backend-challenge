export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor() {
    super('INVALID_TRANSACTION_STATE', 'A terminal transaction cannot change state');
  }
}
