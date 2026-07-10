<?php

declare(strict_types=1);

namespace CleanFixture;

final class Order
{
    /**
     * Whether the order has been settled in full.
     */
    public function isPaid(): bool
    {
        return $this->outstanding === 0;
    }
}
