<?php

declare(strict_types=1);

namespace CleanFixture;

final class Account
{
    /**
     * Current balance in minor units.
     */
    public function balance(): int
    {
        return $this->minorUnits;
    }
}
