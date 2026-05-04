export const contractErrors = [
  {
    "inputs": [],
    "name": "InvalidPrice",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OracleStale",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MaxOrdersPerParticipantReached",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "message",
        "type": "string"
      }
    ],
    "name": "Error",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      },
      {
        "internalType": "uint128",
        "name": "fillSize",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "remaining",
        "type": "uint128"
      }
    ],
    "name": "FillExceedsRemaining",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidIV",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReduceOnlyNoPosition",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSize",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "NotShortPosition",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAmount",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "InsufficientMargin",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "NoPosition",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotSettled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WithdrawalWouldBreachMargin",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "WindowNotElapsed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "str",
        "type": "string"
      }
    ],
    "name": "StringTooLong",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "EmptyQueue",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Overflow",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "ExpiryNotReached",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      },
      {
        "internalType": "uint32",
        "name": "have",
        "type": "uint32"
      },
      {
        "internalType": "uint32",
        "name": "need",
        "type": "uint32"
      }
    ],
    "name": "InsufficientObservations",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidWindow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MaxPriceLevelsReached",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientCollateral",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotActive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientMargin",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotInitialized",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "OrderNotActive",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "signer",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "ERC2612InvalidSigner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "ERC1967InvalidImplementation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "code",
        "type": "uint256"
      }
    ],
    "name": "Panic",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "orderId",
        "type": "uint64"
      }
    ],
    "name": "NotOrderOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "name": "ERC2612ExpiredSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientReservePool",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "MaxSeriesExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "IVSolverPremiumBelowIntrinsic",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTickSize",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "currentNonce",
        "type": "uint256"
      }
    ],
    "name": "InvalidAccountNonce",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroLiquidation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "AlreadyFinalized",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "AlreadyInitiated",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "implementation",
        "type": "address"
      }
    ],
    "name": "BeaconInvalidImplementation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "IVNotInitialized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FOKNotFillable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LnNegativeUndefined",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotRouter",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OrderNotBelongToSender",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "spender",
        "type": "address"
      }
    ],
    "name": "ERC20InvalidSpender",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidOracle",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "AccountHealthy",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesAlreadySettled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLotSize",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "sender",
        "type": "address"
      }
    ],
    "name": "ERC20InvalidSender",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "AddressEmptyCode",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidStrike",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "SeriesNotActiveOrFrozen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferDisabled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ExpOverflow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TickBitmapEmpty",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidParams",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "slot",
        "type": "bytes32"
      }
    ],
    "name": "UUPSUnsupportedProxiableUUID",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidShortString",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ERC1967NonPayable",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "WindowClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidMarginPercent",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidFundingParameters",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidExpiry",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint128",
        "name": "size",
        "type": "uint128"
      },
      {
        "internalType": "uint32",
        "name": "lotSize",
        "type": "uint32"
      }
    ],
    "name": "SizeNotOnLot",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OrderMarginTooLow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FailedCall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "s",
        "type": "bytes32"
      }
    ],
    "name": "ECDSAInvalidSignatureS",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotInitializing",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotLiquidatable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UUPSUnauthorizedCallContext",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "sender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "balance",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "needed",
        "type": "uint256"
      }
    ],
    "name": "ERC20InsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "approver",
        "type": "address"
      }
    ],
    "name": "ERC20InvalidApprover",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAuthorized",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "receiver",
        "type": "address"
      }
    ],
    "name": "ERC20InvalidReceiver",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotSettlement",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "seriesId",
        "type": "uint64"
      }
    ],
    "name": "NotInitiated",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PostOnlyWouldMatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInputs",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ECDSAInvalidSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInitialization",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "spender",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "allowance",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "needed",
        "type": "uint256"
      }
    ],
    "name": "ERC20InsufficientAllowance",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "length",
        "type": "uint256"
      }
    ],
    "name": "ECDSAInvalidSignatureLength",
    "type": "error"
  }
] as const;
