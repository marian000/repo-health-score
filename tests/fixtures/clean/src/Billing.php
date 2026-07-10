<?php

declare(strict_types=1);

namespace CleanFixture;

final class Billing
{
    /**
     * Day of the month the customer is billed on.
     */
    public function cycleDay(): int
    {
        return $this->day;
    }
}
