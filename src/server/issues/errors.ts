import {
    IssueConflict,
    IssueError,
    IssueForbidden,
    IssueInvalid,
    IssueNotFound,
    IssueTooLarge,
    IssueUnsupportedType,
    type IssueFailure,
} from './contract.js';

/**
 * The typed failure for a caught `IssueError`: the tag for its status, the
 * message unchanged.
 */
export function issueFailure(error: IssueError): IssueFailure {
    const { message } = error;
    switch (error.status) {
        case 400:
            return new IssueInvalid({ message });
        case 403:
            return new IssueForbidden({ message });
        case 404:
            return new IssueNotFound({ message });
        case 409:
            return new IssueConflict({ message });
        case 413:
            return new IssueTooLarge({ message });
        case 415:
            return new IssueUnsupportedType({ message });
    }
}
