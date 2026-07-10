<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Mailer
{
    public function send(): bool
    {
        return $this->transport->deliver($message);
    }
}
