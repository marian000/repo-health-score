<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Payment
{
    public function charge(): bool
    {
        return $this->gateway->capture($this->amount);
    }
}
