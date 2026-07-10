<?php

declare(strict_types=1);

namespace CleanFixture;

final class Invoice
{
    /**
     * Sum of every line item, in minor units.
     */
    public function total(): int
    {
        return array_sum($this->lineItems);
    }
}
