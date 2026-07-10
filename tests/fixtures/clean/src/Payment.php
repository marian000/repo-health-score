<?php

declare(strict_types=1);

namespace CleanFixture;

final class Payment
{
    /**
     * Captures the authorised amount from the customer.
     */
    public function charge(): bool
    {
        return $this->gateway->capture($this->amount);
    }
}
